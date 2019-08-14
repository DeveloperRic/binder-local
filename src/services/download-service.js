const fs = require("fs");
const ip = require("ip");
const pathParse = require("path-parse");
const mongoose = require("mongoose");

const {
  isLargeFile,
  clearDir,
  findCommonPrefix
} = require("./coordination.js");
const { getB2Key } = require("../security/keyManagement");
const { decryptAndDecompress } = require("../security/storeSecure");
const { resolveDir } = require("../prodVariables");

const b2 = new (require("backblaze-b2"))(getB2Key());

const User = require("../model/user");
const Tier = require("../model/tier");
const Download = require("../model/download");
const File = require("../model/file");
const Bucket = require("../model/bucket");

const PROGRESS_PATH = resolveDir("data/download/progress.json");
const CAPTURES_PATH = resolveDir("data/download/captures");
const PACKAGE_PATH = resolveDir("data/download/package");

let progress;
let paused = true;
let busy = false;
let allowProcessing = true;
let waiting = false;
let userId;
let userTier;
var initialised = false;
let isUploadsPaused;
let isUploadsWaiting;
let uploadsResume;
let downloadHandlers = {
  resume: null,
  captured: null,
  decrypted: null,
  failed: null,
  allDownloaded: null,
  allFailed: null
};
let throttler = {
  periodStart: -1,
  periodGbs: 0
};

/**
 * Initialises the download-service, resuming downloads,
 * setting state variables, and verifing user's plan status.
 * NOTE: Will reject the promise only if an error occurs or the user's status could not be verified.
 * @param {"ObjectId"} uid
 * @param {function} uploadPaused
 */
function init(uid, uploadPaused, uploadWaiting, uploadResume) {
  return new Promise((resolve, reject) => {
    userId = uid.toString();
    isUploadsPaused = uploadPaused;
    isUploadsWaiting = uploadWaiting;
    uploadsResume = uploadResume;
    fs.mkdir(resolveDir("data/download"), { recursive: true }, err => {
      if (fs.existsSync(PROGRESS_PATH)) {
        progress = JSON.parse(fs.readFileSync(PROGRESS_PATH));
        Download.findById(
          { _id: progress.downloadId, active: true },
          { _id: 1 },
          (err, download) => {
            if (err) return reject(err);
            if (!download) {
              progress = null;
              try {
                fs.unlinkSync(PROGRESS_PATH);
              } catch (err2) {
                return reject(err2);
              }
              return clearCapturesAndPackage()
                .then(() => {
                  finaliseInit()
                    .then(resolve)
                    .catch(reject);
                })
                .catch(reject);
            } else {
              if (progress.failed.length > 0) {
                try {
                  processDownload(
                    {
                      _id: progress.downloadId,
                      files: {
                        list: progress.failed,
                        count: progress.failed.length,
                        totalSize: progress.failed.reduce(
                          (acc, cur) => (acc += cur.size),
                          0
                        )
                      }
                    },
                    progress.commonPrefix
                  );
                  progress.failed.length = 0;
                } catch (err2) {
                  return reject(err2);
                }
              }
              return pullRemainingFiles()
                .then(() => {
                  finaliseInit()
                    .then(resolve)
                    .catch(reject);
                })
                .catch(reject);
            }
          }
        );
      } else {
        clearCapturesAndPackage()
          .then(() => {
            finaliseInit()
              .then(resolve)
              .catch(reject);
          })
          .catch(reject);
      }
    });
  });
}

function finaliseInit() {
  return new Promise((resolve, reject) => {
    User.findById(
      userId,
      { "plan.expired": 1, "plan.tier": 1 },
      (err, user) => {
        if (err) return reject(err);
        if (!user) return reject(new Error("User not found"));
        if (!user.plan) {
          return reject(new Error("User doesn't have a plan"));
        } else if (user.plan.expired) {
          return reject(new Error("User's plan has expired"));
        }
        Tier.findOne(
          { id: user.plan.tier },
          { retrieveSpeed: 1 },
          (err, tier) => {
            if (err) return reject(err);
            if (!tier) return reject(new Error("Failed to load Tier data"));
            userTier = tier;
            b2.authorize()
              .then(() => {
                initialised = true;
                resolve();
              })
              .catch(reject);
          }
        );
      }
    );
  });
}

/**
 * Will update progress with download data stored in MongoDB.
 * If any unfinished files are found, the function will parse them into the progress object
 */
function pullRemainingFiles() {
  return new Promise((resolve, reject) => {
    pause()
      .then(() => {
        Download.aggregate(
          [
            { $match: { user: userId, active: true } },
            { $limit: 1 },
            {
              $project: {
                _id: 1,
                files: "$files.list",
                active: "$active",
                expiresOn: "$expiresOn"
              }
            },
            { $unwind: "$files" },
            { $match: { "files.decryptedDate": { $exists: false } } },
            {
              $group: {
                _id: "$_id",
                fileList: { $push: { idInDatabase: "$files.idInDatabase" } },
                fileCount: { $first: "$files.count" },
                fileTotalSize: { $first: "$files.totalSize" },
                fileCommonPrefix: { $first: "#files.commonPrefix" },
                active: { $first: "$active" },
                expiresOn: { $first: "$expiresOn" }
              }
            }
          ],
          (err, download) => {
            if (err) return reject(err);
            download = download[0];
            if (!download) return resolve();
            if (download.expiresOn <= Date.now()) {
              // whether or not the download is deleted is unimportant
              // TTL indexes have been set and should process the deletion
              Download.deleteOne({ _id: download._id }, () => {});
              if (progress.downloadId == download._id) {
                pause()
                  .then(() => {
                    progress = null;
                    resolve();
                  })
                  .catch(reject);
              } else {
                return resolve();
              }
            }
            download.files = {};
            download.files.list = download.fileList;
            delete download.fileList;
            download.files.count = download.fileCount;
            delete download.fileCount;
            download.files.totalSize = download.fileTotalSize;
            delete download.fileTotalSize;
            let commonPrefix = download.fileCommonPrefix;
            delete download.fileCommonPrefix;
            try {
              processDownload(download, commonPrefix);
            } catch (err2) {
              return reject(err2);
            }
            resolve();
          }
        );
      })
      .catch(reject);
  });
}

function requestDownload(filesToDownload, releasePath) {
  //jshint ignore:start
  return new Promise((resolve, reject) => {
    Download.findOne(
      { user: userId, active: true },
      { _id: 1, task_name: 1 },
      async (err, download) => {
        if (err) return reject(err);
        if (download) {
          return reject(new Error("Other download still exists"));
        }
        if (!filesToDownload || filesToDownload.length == 0) {
          return reject(new Error("filesToDownload is empty"));
        }
        let totalSize;
        let fileObjs;
        try {
          fileObjs = await new Promise((resolve, reject) => {
            // deserialise filesToDownload using the database IDs from MongoDB
            File.find(
              { _id: { $in: filesToDownload } },
              {
                idInDatabase: 1,
                nameInDatabase: 1,
                localPath: 1,
                bucket: 1,
                latestSize: 1
              },
              (err, files) => {
                if (err) return reject(err);
                if (
                  files.findIndex(
                    f =>
                      f.idInDatabase == "unset" || f.idInDatabase == "deleted"
                  ) >= 0
                ) {
                  return reject(
                    new Error(
                      "Some files have unset database IDs / some are deleted"
                    )
                  );
                }
                totalSize = files.reduce(
                  (acc, cur) => (acc += cur.latestSize),
                  0
                );
                resolve(
                  files.map(file => {
                    return {
                      id: file._id,
                      bucket: file.bucket,
                      idInDatabase: file.idInDatabase,
                      nameInDatabase: file.nameInDatabase,
                      localPath: file.localPath,
                      size: file.latestSize
                    };
                  })
                );
              }
            );
          });
        } catch (err) {
          return reject(err);
        }
        if (fileObjs.length != filesToDownload.length) {
          return reject(new Error("Some files were not found in MongoDB"));
        }
        let buckets = {};
        let bucketsArg = new Set();
        fileObjs.forEach(f => bucketsArg.add(f.bucket.toString()));
        bucketsArg = [...bucketsArg];
        try {
          await new Promise((resolve, reject) => {
            Bucket.find(
              { _id: { $in: bucketsArg } },
              { b2_bucket_id: 1 },
              (err, bucketsRes) => {
                if (err) return reject(err);
                bucketsRes.forEach(bucket => {
                  buckets[bucket._id] = bucket.b2_bucket_id;
                });
                resolve();
              }
            );
          });
        } catch (err) {
          return reject(err);
        }
        if (Object.keys(buckets).length != bucketsArg.length) {
          return reject(
            new Error("File {bucket} -> Bucket {b2_bucket_id} mismatch")
          );
        }
        fileObjs.forEach(f => {
          f.b2_bucket_id = buckets[f.bucket];
          delete f.bucket;
        });
        const finishBy =
          Date.now() +
          Math.ceil(
            Math.ceil(totalSize / 1073741824) /
              (userTier.retrieveSpeed + 13.1836)
            //13.1836 accounts for downlaod speed at 30Mbps
          ) *
            (60 * 60 * 1000);
        let commonPrefix = findCommonPrefix(fileObjs);
        let downloadRequest = {
          user: userId,
          files: {
            list: fileObjs,
            count: fileObjs.length,
            totalSize,
            commonPrefix
          },
          finishBy,
          expiresOn: finishBy + 24 * 60 * 60 * 1000,
          releasePath,
          log: {
            requestedDate: Date.now(),
            requestedFromIp:
              ip.address("public", "ipv6") || ip.address("public", "ipv4")
          }
        };
        Download.create(downloadRequest, (err, download) => {
          if (err) return reject(err);
          downloadRequest._id = download._id.toString();
          let cancelOperation = err => {
            Download.deleteOne({ _id: download._id }, err2 => {
              if (err2) return reject([err, err2]);
              reject(err);
            });
          };
          pause()
            .then(() => {
              clearCapturesAndPackage()
                .then(() => {
                  try {
                    processDownload(downloadRequest, commonPrefix);
                  } catch (err) {
                    return reject(err);
                  }
                  resume().catch(cancelOperation);
                  resolve(download._id.toString());
                })
                .catch(cancelOperation);
            })
            .catch(cancelOperation);
        });
      }
    ).lean(true);
  });
  //jshint ignore:end
}

/**
 * Parses a downlaod object from MongoDB into the downlaod 'progress'.
 * If no progress exists, a new one is defined.
 * @param {Object} download
 * @param {string} [commonPrefix]
 * @throws conditionally throws some errros
 */
function processDownload(download, commonPrefix) {
  if (progress && download._id != progress.downloadId) {
    if (progress.toCapture.length != 0 || progress.toDecrypt.length != 0) {
      throw new Error(
        "Download was rejected: There is an unfinished download in progress"
      );
    }
  }
  let toCapture = download.files.list.filter(f => !f.capturedDate);
  let toDecrypt = download.files.list.filter(
    f => f.capturedDate && !f.decryptedDate
  );
  if (toCapture.length + toDecrypt.length != download.files.count) {
    throw new Error(
      "Deconstructed download.files.list contains completed files. " +
        "This should never happen."
    );
  }
  if (!progress) {
    progress = {
      downloadId: download._id,
      toCapture,
      toDecrypt,
      filesLeft: download.files.count,
      bytesLeft: download.files.totalSize,
      releasePath: download.releasePath,
      failed: []
    };
  } else {
    progress.toCapture.push(
      ...toCapture.filter(
        f1 => progress.toCapture.findIndex(f2 => f1.path == f2.path) < 0
      )
    );
    progress.toDecrypt.push(
      ...toDecrypt.filter(
        f1 => progress.toDecrypt.findIndex(f2 => f1.path == f2.path) < 0
      )
    );
    progress.filesLeft = toCapture.length + toDecrypt.length;
    progress.bytesLeft =
      progress.toCapture.reduce((acc, cur) => (acc += cur.size), 0) +
      progress.toDecrypt.reduce((acc, cur) => (acc += cur.size), 0);
  }
  progress.commonPrefix =
    commonPrefix ||
    findCommonPrefix(progress.toCapture.concat(progress.toDecrypt));
  saveProgressSync(progress);
}

/**
 * Warning: this promise doesn't handle rejections!
 * Resolved once the current download settles
 */
function pause() {
  return new Promise((resolve, reject) => {
    if (!progress || paused) return resolve();
    // pause now
    paused = true;
    // resolve now if not downloading
    if (!busy) return resolve();
    // wait till download settles before resolving
    let task = setInterval(() => {
      if (!busy) {
        clearInterval(task);
        resolve();
      }
    }, 1000);
  });
}

/**
 * Warning: this promise will only reject when processing is blocked!
 * Resolved once all files in 'progress' are downloaded
 */
function resume() {
  return new Promise((resolve, reject) => {
    if (!allowProcessing) {
      return reject("Processing has been disabled. Possible plan expiry");
    }
    if (!isUploadsPaused()) {
      waiting = true;
      return reject("Resume blocked. Upload-service still busy");
    }
    waiting = false;
    if (!progress || !paused) return resolve();
    paused = false;
    console.log("download resuming");
    if (downloadHandlers.resume) {
      downloadHandlers.resume(progress);
    }

    // download next file with 3 second interval
    // NOTE slow down first-time downloads so MongoDB
    //   index sizes remain stable (implicit with throttles??)
    let task = setInterval(() => {
      // cancel task if progressr is paused or empty
      if (paused) return clearInterval(task);
      if (progress.toCapture.length == 0 && progress.toDecrypt.length == 0) {
        console.log("download [no tasks]!");
        clearInterval(task);
        if (progress.failed.length == 0) {
          console.log("download [all completed]!");
          if (downloadHandlers.alldownloaded) {
            downloadHandlers.alldownloaded(progress);
          }
          Download.updateOne(
            { _id: progress.downloadId },
            {
              active: false,
              complete: true,
              "log.completedDate": Date.now()
            },
            err => {
              if (err) {
                console.log(
                  "\nCouldn't notify MongoDB of download completion!\n",
                  err
                );
              } else {
                // doesn't matter if it's deleted, at next init
                // the file will be rejected cuz there's no
                // matching document in MongoDB
                fs.unlink(PROGRESS_PATH, err => {
                  console.log(err);
                });
                // same thing goes for this
                clearCapturesAndPackage().catch(err => {
                  console.log(err);
                });
              }
              progress = null;
              paused = true;
              resolve();
            }
          );
        } else {
          console.log("download [some failed]!");
          paused = true;
        }
        // verify the user's plan hasn't epired
        // if it has block future processing
        return verifyPlanNotExpired()
          .catch(err => console.error(err)) // errors aren't a worry here
          .then(resolve);
      }
      // only begin downloading if not currently working
      if (!busy) {
        // check if throttling is necessary
        // 'now' is measured in seconds
        let now = Math.floor(Date.now() / 1000);
        if (throttler.periodStart < 0 || throttler.periodStart + 3600 < now) {
          // reset throttler if the period is over
          throttler.periodStart = now;
          throttler.periodGbs = 0;
        } else {
          if (throttler.periodGbs >= userTier.retrieveSpeed) {
            // if downloads have reached the max threshold
            // block future downloads until the period has passed
            console.log("throttler blocked", throttler);
            return;
          }
        }
        busy = true;
        setImmediate(() => {
          console.log("download starting");
          let nextCapture = progress.toCapture[0];
          let nextDecrypt = progress.toDecrypt[0];
          let actions = [];
          if (nextCapture) {
            actions.push({
              a: "capture",
              p: capture(nextCapture)
            });
          }
          if (nextDecrypt) {
            actions.push({
              a: "decrypt",
              p: decrypt(nextDecrypt)
            });
          }
          actions.forEach(action => {
            action.p
              .finally(() => (action.settled = true))
              .then(() => {
                if (action.a == "capture") {
                  nextCapture.captured = true;
                  //queue successful captures for decryption
                  progress.toDecrypt.push(progress.toCapture.shift());
                  console.log("capture successful");
                  // increment throttler after the successful capture
                  throttler.periodGbs += nextCapture.size / 1073741824;
                } else {
                  nextDecrypt.decrypted = true;
                  //remove successful downloads from progress
                  progress.toDecrypt.shift();
                  progress.filesLeft--;
                  progress.bytesLeft -= nextDecrypt.size;
                  console.log("decrypt successful");
                }
              })
              .catch(err => {
                // NOTE uncomment this to stop when an error occurs
                // paused = true;
                // this ^
                try {
                  console.error(err.response.data);
                } catch (error) {
                  console.log(err.toString());
                }
                let failedObj =
                  action.a == "capture" ? nextCapture : nextDecrypt;
                failedObj.failedTwice = !!failedObj.failedOnce || true; //TODO should we retry?
                failedObj.failedOnce = true;
                if (!failedObj.failedTwice) {
                  if (action.a == "capture") {
                    progress.toCapture.push(progress.toCapture.shift());
                  } else {
                    progress.toDecrypt.push(progress.toDecrypt.shift());
                  }
                } else {
                  delete failedObj.failedOnce;
                  delete failedObj.failedTwice;
                  if (action.a == "capture") {
                    failedObj = progress.toCapture.shift();
                  } else {
                    failedObj = progress.toDecrypt.shift();
                  }
                  progress.failed.push(failedObj);
                  progress.filesLeft--;
                  progress.bytesLeft -= failedObj.size;
                }
              })
              .finally(() => {
                // look for an unsettled promise
                // if none found, we know we are done
                if (!actions.find(a => !a.settled)) {
                  console.log("download(s) [settled]");
                }
                // save progress after each operation
                saveProgress(progress)
                  .catch(err => console.error(err))
                  .finally(() => (busy = false));
              });
          });
        });
      }
    }, 3000);
  }).then(() => {
    if (isUploadsWaiting()) {
      console.log("Upload-service was waiting\nresuming uploads");
      uploadsResume().catch(err => {
        console.log("resume was blocked!\n", err);
      });
    }
  });
}

function capture(fileDat) {
  return new Promise((resolve, reject) => {
    // move capture processes to a new thread
    setImmediate(() => {
      fs.mkdir(CAPTURES_PATH, { recursive: true }, err => {
        if (err) return reject(err);
        let capturePath =
          fileDat.capturePath || `${CAPTURES_PATH}/${fileDat.id.toString()}`;
        fileDat.capturePart = capturePath;
        try {
          if (fs.existsSync(capturePath)) {
            fs.unlinkSync(capturePath);
          }
        } catch (err2) {
          console.log("c| Couldn't clear existing file @ capturePath", err2);
        }
        captureSmallFile(capturePath, fileDat)
          .then(() => {
            cleanupCapture(fileDat, capturePath)
              .then(resolve)
              .catch(reject);
          })
          .catch(reject);
      });
    });
  });
}

function captureSmallFile(capturePath, fileDat) {
  return new Promise((resolve, reject) => {
    console.log("c| capturing using small method");
    b2.downloadFileById({
      fileId: fileDat.idInDatabase,
      responseType: "stream"
    })
      .then(({ data }) => {
        try {
          data
            .pipe(fs.createWriteStream(capturePath))
            .on("close", () => resolve())
            .on("error", err => reject(err));
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}

function cleanupCapture(fileDat, capturePath) {
  return new Promise((resolve, reject) => {
    console.log("c| cleanup", fileDat.idInDatabase);
    b2.getFileInfo({
      fileId: fileDat.idInDatabase
    })
      .then(({ data }) => {
        // with capture, the successful status is only
        // true when the captured file size matches that
        // *IN THE B2 DATABASE*
        if (data.contentLength == fs.statSync(capturePath).size) {
          fileDat.capturedDate = Date.now();
          Download.updateOne(
            { _id: progress.downloadId, "files.list.id": fileDat.id },
            {
              $set: { "files.list.$.capturedDate": fileDat.capturedDate }
            },
            (err, _done) => {
              if (err) return reject(err);
              resolve();
            }
          );
        } else {
          reject(new Error("captured size and fileSize (in B2) do not match"));
        }
      })
      .catch(reject);
  });
}

function decrypt(fileDat) {
  return new Promise((resolve, reject) => {
    // move decrypt to a new thread
    setImmediate(() => {
      let filePath = `${PACKAGE_PATH}/${fileDat.nameInDatabase}`;
      fs.mkdir(pathParse(filePath).dir, { recursive: true }, err => {
        if (err) return reject(err);
        //TODO let user know how much space is required for download
        // cuz we are decrypting THEN deleting so at any given point
        // a file might be duplicated in '/captures' and '/package'
        let capturePath =
          fileDat.capturePath || `${CAPTURES_PATH}/${fileDat.id.toString()}`;
        decryptSmallFile(fileDat, filePath, capturePath)
          .then(() => {
            cleanupDecrypt(fileDat, capturePath, filePath)
              .then(resolve)
              .catch(reject);
          })
          .catch(reject);
      });
    });
  });
}

function decryptSmallFile(fileDat, filePath, capturePath) {
  return new Promise((resolve, reject) => {
    File.aggregate(
      [
        { $match: { _id: mongoose.Types.ObjectId(fileDat.id) } },
        { $project: { _id: 1, versions: "$versions.list" } },
        { $unwind: "$versions" },
        { $match: { "versions.idInDatabase": fileDat.idInDatabase } },
        { $project: { _id: 1, initVect: "$versions.initVect" } }
      ],
      (err, file) => {
        if (err) return reject(err);
        file = file[0];
        if (!file || !file.initVect) {
          return reject(new Error("couldn't retrieve initVect"));
        }
        try {
          decryptAndDecompress(
            capturePath,
            userId,
            Buffer.from(file.initVect, "hex"),
            fs.createWriteStream(filePath)
          )
            .then(() => resolve())
            .catch(reject);
        } catch (err2) {
          reject(err2);
        }
      }
    );
  });
}

function cleanupDecrypt(fileDat, capturePath, filePath) {
  return new Promise((resolve, reject) => {
    let successful = fs.statSync(filePath).size == fileDat.size;
    if (successful) {
      releaseFile(fileDat, filePath)
        .then(newPath => {
          fs.unlink(capturePath, err => {
            if (err) {
              // this isn't too much of a worry, it will get
              // cleared at the end/on restart
              console.error(
                "Couldn't delete capture file after download\n",
                err
              );
            } else {
              fileDat.decryptedDate = Date.now();
              Download.updateOne(
                { _id: progress.downloadId, "files.list.id": fileDat.id },
                {
                  $set: { "files.list.$.decryptedDate": fileDat.decryptedDate }
                },
                (err, _done) => {
                  if (err) {
                    return fs.rename(newPath, filePath, err2 => {
                      if (err2) return reject([err, err2]);
                      return reject(err);
                    });
                  }
                  resolve();
                }
              );
            }
          });
        })
        .catch(reject);
    } else {
      reject(
        new Error("decrypted size and fileSize (in MongoDB) do not match")
      );
    }
  });
}

function releaseFile(fileDat, filePath) {
  return new Promise((resolve, reject) => {
    let localPathInfo = pathParse(fileDat.localPath);
    let localPathDir = localPathInfo.dir
      .replace(progress.commonPrefix, "")
      .replace(localPathInfo.root, "");
    while (localPathDir.charAt(0) == "/" || localPathDir.charAt(0) == "\\") {
      localPathDir = localPathDir.substr(1);
    }
    let newPath = `${progress.releasePath}/${localPathDir}/${
      localPathInfo.base
    }`;
    fs.mkdir(pathParse(newPath).dir, { recursive: true }, err => {
      if (err) return reject(err);
      fs.rename(filePath, newPath, err => {
        if (err) return reject(err);
        resolve(newPath);
      });
    });
  });
}

/**
 * This function will query if the user's plan has expired.
 * If it has, future processing will be blocked and the promise rejected.
 * Otherwise, the promise will resolve.
 * NOTE: the function will also block processing if an error occurs
 */
function verifyPlanNotExpired() {
  return new Promise((resolve, reject) => {
    User.findOne({ _id: userId }, { "plan.expired": 1 }, (err, user) => {
      if (err) {
        allowProcessing = false;
        return reject(err);
      }
      if (!user) {
        allowProcessing = false;
        return reject(
          new Error("invalid initialisation of userId (user not found)")
        );
      }
      if (!user.plan || user.plan.expired) {
        allowProcessing = false;
        return reject();
      } else {
        resolve();
      }
    });
  });
}

function setDownloadHandlers(handlers) {
  for (let key in handlers) {
    if (downloadHandlers.hasOwnProperty(key)) {
      downloadHandlers[key] = handlers[key];
    }
  }
}

function saveProgress(progress) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        saveProgressSync(progress);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function saveProgressSync(progress) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress));
}

function clearCapturesAndPackage() {
  return Promise.all([clearDir(CAPTURES_PATH), clearDir(PACKAGE_PATH)]);
}

// download (capture) file > decrypt file > release file > next...

module.exports = {
  init,
  isInitialised: () => initialised,
  pause,
  isPaused: () => paused,
  resume,
  isWaiting: () => waiting,
  setDownloadHandlers,
  getProgress: () => progress,
  requestDownload
};
