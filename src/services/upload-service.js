const fs = require("fs");
const crypto = require("crypto");
const mime = require("mime-types");
const b2 = new (require("backblaze-b2"))({
  accountId: "002d12b0f670f5c0000000001", // or accountId
  applicationKey: "K002rxvrTjAQtnrFRJTcTss/PiWwqKY"
});
const ip = require("ip");
const pathParse = require("path-parse");
const Tier = require("../model/tier");
const User = require("../model/user");
const Bucket = require("../model/bucket");
const Block = require("../model/block");
const File = require("../model/file");

let currentSchedule;
let paused = true;
let uploading = false;
let processedUpload = true;
let allowProcessing = true;
let allowedBlocks = [];
let userId;
let userTier;
var initialised = false;
let uploadHandlers = {
  resume: null,
  progress: null,
  success: null,
  failed: null,
  allUploaded: null,
  allFailed: null
};
let throttler = {
  periodStart: -1,
  periodGbs: 0
};

// NOTE timeouts on all local processes (?)
// e.g.) pause() and resume()

function finaliseInit(uid, resolve, reject) {
  // get user info for use in uploads
  User.findById(uid, { plan: 1 }, (err, user) => {
    if (err) return reject(err);
    if (!user) return reject(new Error("User not found"));
    if (!user.plan) {
      return reject(new Error("User doesn't have a plan"));
    } else if (user.plan.expired) {
      return reject(new Error("User's plan has expired"));
    }
    // get user's blocks for use in uploads
    Block.find(
      { _id: { $in: user.plan.blocks } },
      { _id: 1, bucket: 1, maxSize: 1, latestSize: 1 },
      (err, blocks) => {
        if (err) return reject(err);
        if (blocks.length == 0) {
          return reject(new Error("No allowed blocks found"));
        }
        // get associated buckets for b2_bucket_id selection
        Bucket.find(
          { _id: { $in: blocks.map(bl => bl.bucket) } },
          { _id: 1, b2_bucket_id: 1 },
          (err, buckets) => {
            if (err) return reject(err);
            if (buckets.length == 0) {
              return reject(
                new Error("No allowed buckets found / bucket mismatch")
              );
            }
            allowedBlocks.length = 0;
            // ensure correct retrieval of blocks and their buckets
            for (let i in blocks) {
              const block = blocks[i];
              let bucket = buckets.find(
                bu => bu._id.toString() == block.bucket
              );
              if (!bucket) {
                return reject(new Error("Bucket mismatch"));
              }
              allowedBlocks.push({
                _id: block._id.toString(),
                bucket: {
                  _id: bucket._id.toString(),
                  b2_bucket_id: bucket.b2_bucket_id
                },
                maxSize: block.maxSize
              });
            }
            // get user's plan tier info for version control
            // and archive throttling
            Tier.findOne(
              { id: user.plan.tier },
              { archiveSpeed: 1, fileVersioningAllowed: 1 },
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
        ).lean(true);
      }
    );
  });
}

/**
 * Initialises the upload-service, resuming uploads,
 * setting state variables, and verifing user's plan status.
 * NOTE: Will reject the promise only if an error occurs or the user's status could not be verified.
 * @param {"ObjectId"} uid
 */
function init(uid) {
  return new Promise((resolve, reject) => {
    userId = uid;
    let schedules = [];
    // get saved schedules
    fs.readdir("src/data/upload", { withFileTypes: true }, (err, files) => {
      if (err) throw err;
      files = files.filter(file => file.isFile());
      // finalise if no schedules found
      if (files.length == 0) {
        initialised = true;
        return finaliseInit(uid, resolve, reject);
      }
      // parse all schedules
      files.forEach(file => {
        schedules.push(
          JSON.parse(fs.readFileSync(`src/data/upload/${file.name}`))
        );
      });
      // sort files within all schedules
      schedules.forEach(schedule => {
        schedule.changed = schedule.changed.sort((a, b) => {
          return (
            a.modified -
            b.modified +
            (a.bytes.total - a.bytes.done - (b.bytes.total - b.bytes.done))
          );
        });
      });
      schedules.forEach(schedule => {
        schedule.removed = schedule.removed.sort((a, b) => {
          return (
            a.modified -
            b.modified +
            (a.bytes.total - a.bytes.done - (b.bytes.total - b.bytes.done))
          );
        });
      });
      // sort schedules
      schedules = schedules.sort((a, b) => a.created - b.created);
      // merge all schedules and save them
      let mergedSchedule = mergeSchedules(schedules);
      // filter out files that no longer exist
      // **such files will be detected later by the spider
      mergedSchedule.changed = mergedSchedule.changed.filter(v =>
        fs.existsSync(v.path)
      );
      saveSchedule(mergedSchedule)
        .then(() => {
          // once saved, delete all other schedules
          files.forEach(file => fs.unlinkSync(`src/data/upload/${file.name}`));
          // finalise initialisation
          finaliseInit(
            uid,
            () => {
              currentSchedule = mergedSchedule;
              resolve();
            },
            reject
          );
        })
        .catch(reject);
    });
  });
}

/**
 * NOTE: The order in which (schedules) is provided
 * defines the order in which files will appear in the
 * merged schedule. So ensure you've sorted both the param
 * array as well as the schedules themselves!
 * @param {[{ files: Array, created: Date }]} schedules
 */
function mergeSchedules(schedules) {
  let changesSeen = [];
  let removedSeen = [];
  // iterate through supplied schedules
  for (let i in schedules) {
    let schedule = schedules[i];
    // iterate through their changes
    for (let j = 0; j < schedule.changed.length; j++) {
      let file = schedule.changed[j];
      // skip merged files
      if (changesSeen.includes(file.path)) {
        schedule.changed.splice(j, 1);
        j--;
        continue;
      } else changesSeen.push(file.path);
    }
    // iterate through their removals
    for (let j = 0; j < schedule.removed.length; j++) {
      let file = schedule.removed[j];
      // skip merged files
      if (removedSeen.includes(file.path)) {
        schedule.removed.splice(j, 1);
        j--;
        continue;
      } else removedSeen.push(file.path);
    }
  }
  let mergedSchedule = {
    changed: [],
    removed: [],
    created: new Date().getTime()
  };
  schedules.forEach(schedule => {
    // merge schedules
    mergedSchedule.changed = mergedSchedule.changed.concat(schedule.changed);
    mergedSchedule.removed = mergedSchedule.removed.concat(schedule.removed);
  });
  return mergedSchedule;
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

/**
 * Warning: this promise will only reject when processing is blocked!
 * Resolved once the current upload settles
 */
function processChanges(changes, removed) {
  return new Promise(async (resolve, reject) => {
    if (!allowProcessing) {
      return reject({
        msg: "Processing has been disabled. Possible plan expiry",
        processingBlocked: true
      });
    }
    if (changes.length == 0 && removed.length == 0) {
      return resolve();
    }
    console.log("upload processing");
    // build new schedule based on updates
    let uploadSchedule = {
      changed: changes,
      removed: removed,
      created: new Date().getTime()
    };
    for (let i in uploadSchedule.changed) {
      let change = uploadSchedule.changed[i];
      try {
        let changeIsNewer = await checkIfChangeIsNewer(
          change.path,
          change.modified
        );
        if (!changeIsNewer) {
          console.log("skipped change", change);
          uploadSchedule.changed.splice(i, 1);
          i--;
          continue;
        }
      } catch (err) {
        // if an error occurs, we assume the change is newer
        console.error(err);
      }
    }
    function checkIfChangeIsNewer(localPath, modifiedTime) {
      return new Promise((resolve, reject) => {
        File.findOne(
          { localPath: localPath, owner: userId },
          { "log.lastModifiedTime": 1 },
          (err, file) => {
            if (err) return reject(err);
            if (!file || !file.log.lastModifiedTime) {
              resolve(true);
            } else {
              console.log(modifiedTime, file.log.lastModifiedTime);
              resolve(modifiedTime > file.log.lastModifiedTime);
            }
          }
        );
      });
    }
    // wait for current upload to settle
    pause().then(() => {
      console.log("upload paused");
      // will apply uploadSchedule to
      // current schedule, save then resume
      let onMerged = mergedSchedule => {
        currentSchedule = mergedSchedule;
        // sort changes ensuring smaller files are uploaded first
        currentSchedule.changed = currentSchedule.changed.sort(
          (a, b) => a.bytes.total - b.bytes.total
        );
        saveSchedule(mergedSchedule)
          .then(() => {
            resume().catch(reject);
            resolve();
          })
          .catch(err => {
            reject(err);
          });
      };
      // merge current and upload schedules
      // only if the currentSchedule exists
      // (typically during the first cycle)
      if (currentSchedule) {
        // apply mergedSchedule
        onMerged(mergeSchedules([uploadSchedule, currentSchedule]));
      } else {
        // if currentSchedule doesn't exist
        // apply uploadSchedule immediately
        onMerged(uploadSchedule);
      }
    });
  });
}

function setUploadHandlers(handlers) {
  for (let key in handlers) {
    if (uploadHandlers.hasOwnProperty(key)) {
      uploadHandlers[key] = handlers[key];
    }
  }
}

function saveSchedule(schedule) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        saveScheduleSync(schedule);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function saveScheduleSync(schedule) {
  fs.writeFileSync(
    `src/data/upload/schedule_${schedule.created}.json`,
    JSON.stringify(schedule)
  );
}

/**
 * Warning: this promise doesn't handle rejections!
 * Resolved once the current upload settles
 */
function pause() {
  return new Promise((resolve, reject) => {
    if (!currentSchedule || paused) return resolve();
    // pause now
    paused = true;
    // resolve now if not uploading
    if (!uploading) return resolve();
    // wait till upload settles before resolving
    let task = setInterval(() => {
      if (!uploading) {
        clearInterval(task);
        resolve();
      }
    }, 1000);
  });
}

/**
 * Warning: this promise will only reject when processing is blocked!
 * Resolved once all files in the scheduler are uploaded
 */
function resume() {
  return new Promise((resolve, reject) => {
    if (!allowProcessing) {
      return reject("Processing has been disabled. Possible plan expiry");
    }
    if (!currentSchedule || !paused) return resolve();
    paused = false;
    console.log("upload resuming");
    if (uploadHandlers.resume) {
      uploadHandlers.resume(currentSchedule);
    }

    // upload next file with 3 second interval
    // NOTE slow down first-time uploads so MongoDB
    //   index sizes remain stable (implicit with throttles??)
    let task = setInterval(() => {
      // cancel task if scheduler is paused or empty
      if (paused) return clearInterval(task);
      if (
        currentSchedule.changed.length == 0 &&
        currentSchedule.removed.length == 0
      ) {
        console.log("upload [no tasks]!");
        clearInterval(task);
        if (uploadHandlers.allUploaded) {
          uploadHandlers.allUploaded(currentSchedule);
        }
        console.log("upload [all completed]!");
        // verify the user's plan hasn't epired
        // if it has block future processing
        return verifyPlanNotExpired()
          .catch(err => console.error(err)) // errors aren't a worry here
          .then(resolve);
      }
      // only begin uploading if not currently working
      if (!uploading && processedUpload) {
        // check if throttling is necessary
        // 'now' is measured in seconds
        let now = Math.floor(new Date().getTime() / 1000);
        if (throttler.periodStart < 0 || throttler.periodStart + 3600 < now) {
          // reset throttler if the period is over
          throttler.periodStart = now;
          throttler.periodGbs = 0;
        } else {
          if (throttler.periodGbs >= userTier.archiveSpeed) {
            // if uploads have reached the max threshold
            // block future uploads until the period has passed
            console.log("throttler blocked", throttler);
            return;
          }
        }
        processedUpload = false;
        setImmediate(() => {
          console.log("upload starting");
          let promises = [];
          let longestTimeout = 1000;
          // process changed files
          if (currentSchedule.changed.length > 0) {
            let nextChange = currentSchedule.changed[0];
            console.log("nextFile > " + pathParse(nextChange.path).name);
            if (isLargeFile(nextChange)) {
              longestTimeout = 5000;
              setTimeout(() => {
                promises.push({
                  item: nextChange,
                  promise: uploadLargeFile(nextChange)
                });
              }, 5000);
            } else {
              longestTimeout = 3000;
              setTimeout(() => {
                promises.push({
                  item: nextChange,
                  promise: uploadSmallFile(nextChange)
                });
              }, 3000);
            }
          }
          // process removed files
          if (currentSchedule.removed.length > 0) {
            let item = currentSchedule.removed[0];
            setTimeout(() => {
              let removePromise = removeFile(item);
              promises.push({
                item: item,
                promise: removePromise
              });
              removePromise.catch(() => {
                currentSchedule.removed.push(currentSchedule.removed.shift());
              });
              removePromise.then(() => {
                if (currentSchedule.removed[0] == item) {
                  currentSchedule.removed.shift();
                }
              });
            }, 1000);
          }
          // attach handlers for the promises
          // this is done after a delay to ensure
          // all promises are present
          setTimeout(() => {
            promises.forEach(p => {
              p.promise
                // mark the promise as settled
                .finally(() => (p.settled = true))
                // catch and log errors
                .catch(err => {
                  //NOTE use this to stop when an error occurs
                  // paused = true;
                  // this ^
                  try {
                    console.error(err.response.data);
                  } catch (error) {
                    console.log(err.toString());
                  }
                  if (p.item.bytes) {
                    p.item.bytes.failed =
                      p.item.bytes.total - p.item.bytes.done;
                  } else {
                    p.item.failed = true;
                  }
                })
                .then(() => {
                  //remove successfull uploads from the schedule
                  if (p.item.bytes) {
                    // done+failed bytes must exactly match total size to be successful
                    if (
                      p.item.bytes.failed == 0 &&
                      p.item.bytes.done + p.item.bytes.failed ==
                        p.item.bytes.total
                    ) {
                      currentSchedule.changed.splice(
                        currentSchedule.changed.findIndex(
                          change => change.path == p.item.path
                        ),
                        1
                      );
                      console.log("upload confirmed successful");
                      // increment throttler of the successful upload
                      throttler.periodGbs += p.item.bytes.total / 1073741824;
                    } else {
                      console.log("upload incomplete!");
                    }
                  } else if (!p.item.failed) {
                    currentSchedule.removed.splice(
                      currentSchedule.removed.findIndex(
                        removal => removal.path == p.item.path
                      ),
                      1
                    );
                  }
                })
                .finally(() => {
                  // look for an unsettled promise
                  // if none found, we know we are done
                  if (!promises.find(pr => !pr.settled)) {
                    processedUpload = true;
                    console.log("upload(s) [settled]");
                  }
                  // save currentSchedule after each operation
                  saveSchedule(currentSchedule).catch(err =>
                    console.error(err)
                  );
                });
            });
          }, longestTimeout + 1000);
        });
      }
    }, 3000);
  });
}

function isLargeFile(fileDat) {
  // 1   gb  = 1073741824
  // 150 mb  = 157286400
  // 50  mb  = 52428800
  return fileDat.bytes.total >= 157286400;
}

function countPartsForLargeFile(fileDat) {
  // divide into 50mb parts
  let partsCount = Math.ceil(fileDat.bytes.total / 52428800);
  // can have at most 10,000 parts per large upload
  return partsCount <= 10000 ? partsCount : 10000;
}

function randomFileName() {
  let name = "unversioned/";
  if (userTier.fileVersioningAllowed) {
    name = "versioned/";
  }
  name += `${userId}/${crypto.randomBytes(48).toString("hex")}`;
  return name;
}

function filterMergedBlocksOutOfAllowedBlocks() {
  return new Promise((resolve, reject) => {
    Block.find(
      {
        _id: { $in: allowedBlocks.map(b => b._id) },
        mergedInto: { $exists: true }
      },
      { _id: 1 },
      (err, blocks) => {
        if (err) return reject(err);
        allowedBlocks = allowedBlocks.filter(
          // select blocks that don't match the above query
          ab => blocks.findIndex(b => b._id == ab._id.toString()) < 0
        );
        return resolve();
      }
    ).lean(true);
  });
}

function selectUploadBlock(fileDat) {
  return new Promise(async (resolve, reject) => {
    let fileBlock;
    try {
      await filterMergedBlocksOutOfAllowedBlocks();
      fileBlock = await new Promise((resolve, reject) => {
        File.findOne(
          { localPath: fileDat.path, owner: userId },
          {
            nameInDatabase: 1,
            block: 1,
            binned: 1,
            versions: 1,
            latestSize: 1
          },
          (err, file) => {
            if (err) return reject(err);
            if (file) {
              let sendResolve = mergedInto => {
                resolve({
                  nameInDatabase: file.nameInDatabase,
                  block: file.block,
                  bucket: allowedBlocks.find(
                    bl => bl._id == file.block.toString()
                  ).bucket,
                  binned: file.binned,
                  version: file.versions.length + 1,
                  fileLatestSize: file.latestSize,
                  mergedInto
                });
              };
              Block.findById(file.block, { mergedInto: 1 }, (err, block) => {
                if (err) return reject(err);
                if (block.mergedInto) {
                  return sendResolve(block.mergedInto);
                  // Bucket.findById(
                  //   block.mergedInto.bucket,
                  //   { b2_bucket_id: 1 },
                  //   (err, bucket) => {
                  //     if (err || !bucket) {
                  //       return reject(err || new Error("Bucket not found"));
                  //     }
                  //     return sendResolve(bucket.b2_bucket_id, block.mergedInto);
                  //   }
                  // );
                } else {
                  return sendResolve();
                }
              }).lean(true);
            } else {
              resolve({
                nameInDatabase: randomFileName(),
                isNew: true
              });
            }
          }
        ).lean(true);
      });
    } catch (err) {
      return reject(err);
    }
    if (fileBlock.isNew) {
      Block.find(
        {
          _id: { $in: allowedBlocks.map(b => b._id) },
          $expr: {
            $lte: [{ $add: ["$latestSize", fileDat.bytes.total] }, "$maxSize"]
          }
        },
        { _id: 1 },
        (err, blocks) => {
          if (err) throw err;
          if (blocks.length == 0) {
            return reject(new Error("File is too big to fit in any block"));
          }
          // select a block and find it's equivalent
          // in the set of allowed blocks (random selection = Math.floor(Math.random() * blocks.length))
          let selectedBlock = allowedBlocks.find(b => b._id == blocks[0]._id);
          fileBlock.block = selectedBlock._id;
          fileBlock.bucket = selectedBlock.bucket;
          resolve(fileBlock);
        }
      )
        // sort blocks in ascending order by latestsize
        // then select the smallest block
        .sort({ latestSize: 1 })
        .limit(1);
    } else {
      Block.findById(
        fileBlock.block,
        { latestSize: 1, maxSize: 1 },
        (err, block) => {
          if (err) return reject(err);
          let projectedBlockSize;
          let fileUpdateOverhead =
            fileDat.bytes.total - fileBlock.fileLatestSize;
          if (fileBlock.fileLatestSize) {
            projectedBlockSize = block.latestSize + fileUpdateOverhead;
          } else {
            projectedBlockSize = block.latestSize + fileDat.bytes.total;
          }
          if (projectedBlockSize > block.maxSize) {
            if (fileUpdateOverhead < 0) {
              // if the update reduces the file size AND the
              // block is still projected to be too big, something's wrong
              return reject(
                new Error(
                  `Block ${
                    block._id
                  } has corrupted latestSize and/or maxSize fields!`
                )
              );
            }
            // find a block with free space >= this file's overhead
            // and transfer free space from it equel to this file's overhead
            // if a block isn't found, we may have to merge blocks
            // depending on the size of the file (file.size < block.maxSize)
            Block.aggregate(
              [
                {
                  $match: {
                    _id: { $in: allowedBlocks.map(b => b._id) },
                    $expr: {
                      // find blocks with enough space to give away
                      $gte: [
                        { $subtract: ["$maxSize", fileUpdateOverhead] },
                        "$latestSize"
                      ]
                    }
                  }
                },
                // select the block with least used space
                { $sort: { latestSize: 1 } },
                { $limit: 1 }
              ],
              (err, blocks) => {
                if (err || blocks.length == 0) {
                  return reject(
                    new Error(
                      "Failed to allocate more space in the block for the file update"
                    )
                  );
                }
                Block.aggregate(
                  [
                    { $match: { _id: blocks[0]._id } },
                    // subtract its maxSize by fileUpdateOverhead
                    {
                      $addFields: {
                        maxSize: { $subtract: ["$maxSize", fileUpdateOverhead] }
                      }
                    },
                    { $limit: 0 },
                    // select the file's current block
                    { $match: { _id: fileBlock.block } },
                    // add extra space to the block
                    {
                      $addFields: {
                        maxSize: { $add: ["$maxSize", fileUpdateOverhead] }
                      }
                    },
                    // refuse returning of block data (saves network use)
                    { $limit: 0 }
                  ],
                  err => {
                    if (err) {
                      return reject(
                        new Error(
                          "Failed to allocate more space in the block for the file update"
                        )
                      );
                    }
                    resolve(fileBlock);
                  }
                );
              }
            );
          } else {
            resolve(fileBlock);
          }
        }
      );
    }
  });
}

function preUpload(fileDat) {
  return new Promise((resolve, reject) => {
    selectUploadBlock(fileDat)
      .then(fileBlock => {
        console.log(fileBlock);
        let now = new Date().getTime();
        // Define file object now to use less
        // internet after upload complete
        // to ensure MongoDB integrity
        let fileDoc = {
          "upload.started": now,
          $unset: {
            "upload.paused": "",
            "upload.finished": ""
          },
          pendingDeletion: false,
          deleted: false,
          latestSize: fileDat.bytes.total,
          "log.lastestSizeCalculationDate": now,
          "log.lastModifiedTime": fileDat.modified
        };
        fileDat.isNew = fileBlock.isNew;
        fileDat.binned = fileBlock.binned;
        if (fileBlock.version) {
          fileDat.version = fileBlock.version;
        }
        if (fileBlock.isNew) {
          fileDoc.idInDatabase = "unset";
          fileDoc.nameInDatabase = fileBlock.nameInDatabase;
          fileDoc.block = fileBlock.block;
          fileDoc.bucket = fileBlock.bucket;
          fileDoc.download = {};
          fileDoc.originalSize = fileDat.bytes.total;
          fileDoc["log.detected"] = now;
          fileDoc.$push = {
            "log.sizeHistory": {
              $each: [
                {
                  date: now,
                  size: fileDat.bytes.total
                }
              ],
              $sort: { date: -1 }
            }
          };
        }
        // Update the file's details, creating
        // a new one if none is found
        File.updateOne(
          { localPath: fileDat.path, owner: userId },
          fileDoc,
          { upsert: true },
          (err, _done) => {
            if (err) {
              uploading = false;
              return reject(err);
            }
            resolve(fileBlock);
          }
        );
      })
      .catch(err => {
        uploading = false;
        reject(err);
      });
  });
}

function uploadSmallFile(fileDat) {
  return new Promise((resolve, reject) => {
    uploading = true;
    console.log("upload small file beginning");
    preUpload(fileDat)
      .then(fileBlock => {
        b2.getUploadUrl(fileBlock.bucket.b2_bucket_id)
          .then(({ data }) => {
            b2.uploadFile({
              uploadUrl: data.uploadUrl,
              uploadAuthToken: data.authorizationToken,
              fileName: fileBlock.nameInDatabase,
              mime: mime.lookup(fileDat.path),
              data: fs.readFileSync(fileDat.path),
              info: {
                "src-last-modified-millis": new Date(fileDat.modified).getTime()
              },
              onUploadProgress: e => onUploadProgress(fileDat, e)
            })
              .then(({ data }) => onUploadComplete(fileDat, data, resolve))
              .catch(err => onUploadFail(fileDat, err, resolve, reject));
          })
          .catch(err => {
            fileDat.failedOnUrl = true;
            onUploadFail(fileDat, err, resolve, reject);
          });
      })
      .catch(reject);
  });
}

//TODO encrypt & compress data before uploading
function uploadLargeFile(fileDat) {
  return new Promise((resolve, reject) => {
    uploading = true;
    console.log("upload large file beginning");
    preUpload(fileDat)
      .then(fileBlock => {
        b2.startLargeFile({
          bucketId: fileBlock.bucket.b2_bucket_id,
          fileName: fileBlock.nameInDatabase || randomFileName(),
          contentType: mime.lookup(fileDat.path)
        })
          .then(({ data }) => {
            let heldPromises = [];
            let fileDescriptor = fs.openSync(fileDat.path, "r");
            let fileDataSize = fs.statSync(fileDat.path).size;
            // calculate part sizes
            console.log("large file length", fileDataSize);
            let partsCount = countPartsForLargeFile(fileDat);
            console.log("large file partsCount", partsCount);
            let partWidth = Math.ceil(fileDataSize / partsCount);
            console.log("large file partWidth", partWidth);
            var partSha1Array = new Array(partsCount);
            // check for any progress info
            if (fileDat.parts) {
              // start uploading incomplete/failed parts
              fileDat.parts
                .filter(p => !p.done)
                .forEach(part => {
                  heldPromises.push(
                    holdPartPromise(part.number, part.start, part.length)
                  );
                });
              // extract SHA1 keys for partSha1Array
              fileDat.parts
                .filter(p => p.done)
                .forEach(part => {
                  partSha1Array[part.number] = part.contentSha1;
                });
            } else {
              // generate promises for each part
              // and begin executing them
              fileDat.parts = new Array(partsCount - 1);
              for (let i = 0; i < partsCount; i++) {
                // promise starts after a relative delay
                // this is to avoid overloaing the b2 database
                const constI = i;
                heldPromises.push(
                  holdPartPromise(constI + 1, constI * partWidth, partWidth)
                );
              }
            }
            setImmediate(async () => {
              // sequentially execute each part promise
              let aPartFailed = false;
              while (heldPromises.length > 0 && !aPartFailed) {
                try {
                  await heldPromises.shift()();
                } catch (err) {
                  onUploadFail(fileDat, err, resolve, reject);
                  aPartFailed = true;
                  return;
                }
              }
              // part promises must have set the fileId
              // and fully populated the SHA1 array
              partSha1Array = partSha1Array.filter(v => v != null);
              if (!data.fileId || partSha1Array.length != partsCount) {
                return onUploadFail(
                  fileDat,
                  new Error(
                    "fileId / SHA1 array not fully populated by part promises"
                  ),
                  resolve,
                  reject
                );
              }
              console.log(partSha1Array.length, partSha1Array);
              b2.finishLargeFile({
                fileId: data.fileId,
                partSha1Array: partSha1Array
              })
                .then(({ data }) => {
                  console.log("upload large file completed");
                  // large files track progress differently
                  // so we have to manually set it to done
                  fileDat.bytes = {
                    total: fileDat.bytes.total,
                    done: fileDat.bytes.total,
                    failed: 0
                  };
                  onUploadComplete(fileDat, data, resolve);
                })
                .catch(err => {
                  // upload might have finished
                  // we need to confirm (after 5 seconds)
                  setTimeout(() => {
                    b2.getFileInfo(data.fileId)
                      .then(({ data }) =>
                        onUploadComplete(fileDat, data, resolve)
                      )
                      .catch(() => onUploadFail(fileDat, err, resolve, reject));
                  }, 5000);
                });
            });
            /**
             * This function will hold a promise to upload a chunk of a large file.
             * It is executed when the preceeding promise is successful (in order to save memory).
             * **Large files upload data with separate promises
             * @param {number} partNumber
             * @param {number} partStart
             * @param {number} partLength
             */
            function holdPartPromise(partNumber, partStart, partLength) {
              return () => {
                // init progress tracker before starting
                let partProgress = (fileDat.parts[partNumber - 1] = {
                  number: partNumber,
                  start: partStart,
                  length: partLength,
                  bytes: {}
                });
                saveScheduleSync(currentSchedule);
                return new Promise((resolve, reject) => {
                  setImmediate(() => {
                    let part = Buffer.alloc(
                      Math.min(fileDataSize - partStart, partLength)
                    );
                    fs.readSync(fileDescriptor, part, 0, partLength, partStart);
                    b2.getUploadPartUrl({
                      fileId: data.fileId
                    })
                      .then(({ data }) => {
                        console.log(
                          partNumber,
                          "got url datLen =",
                          part.length
                        );
                        b2.uploadPart({
                          partNumber: partNumber,
                          uploadUrl: data.uploadUrl,
                          uploadAuthToken: data.authorizationToken,
                          data: part,
                          onUploadProgress: e =>
                            onUploadProgress(fileDat, e, partNumber)
                        })
                          .then(({ data }) => {
                            console.log(partNumber, "part done");
                            partSha1Array[partNumber] = data.contentSha1;
                            // mark progress tracker as complete
                            partProgress.done = true;
                            partProgress.contentSha1 = data.contentSha1;
                            fileDat.bytes.done += partProgress.bytes.done;
                            saveScheduleSync(currentSchedule);
                            resolve();
                          })
                          .catch(reject);
                      })
                      .catch(err => {
                        console.log(partNumber, "part failed");
                        fileDat.failedOnUrl = true;
                        reject(err);
                      });
                  });
                });
              };
            }
          })
          .catch(err => onUploadFail(fileDat, err, resolve, reject));
      })
      .catch(reject);
  });
}

function onUploadProgress(fileDat, event, pn) {
  setImmediate(() => {
    console.log(pn, "progress..");
    if (pn) {
      fileDat.parts[pn - 1].bytes.done = event.loaded;
      fileDat.parts[pn - 1].bytes.total = event.total;
      fileDat.bytes.done = fileDat.parts.reduce(
        (acc, cur) => (acc += cur.bytes.done),
        0
      );
      fileDat.bytes.total = fileDat.parts.reduce(
        (acc, cur) => (acc += cur.bytes.total),
        0
      );
    } else {
      fileDat.bytes.done = event.loaded;
      fileDat.bytes.total = event.total;
    }
    if (uploadHandlers.progress) {
      uploadHandlers.progress(fileDat, pn);
    }
  });
}

function onUploadFail(fileDat, err, resolve, reject) {
  fileDat.bytes.failed = fileDat.bytes.total - fileDat.bytes.done;
  // Retry the upload *once* if BackBlaze failed
  // to provide an upload URL.
  // (All other errors are valid.)
  fileDat.pendingRetry = true;
  if (fileDat.failedOnUrl && !fileDat.retried) {
    //NOTE create a handler for if bucket is busy
    console.log("upload failed (bucket is busy) retrying in 5 seconds");
    // only retry if not paused
    if (!paused) {
      setTimeout(() => {
        uploading = false;
        fileDat.retried = true;
        delete fileDat.pendingRetry;
        console.log("upload retrying");
        // files >= 150mb are considered large
        if (isLargeFile(fileDat)) {
          uploadLargeFile(fileDat)
            .then(resolve)
            .catch(reject);
        } else {
          uploadSmallFile(fileDat)
            .then(resolve)
            .catch(reject);
        }
      }, 5000);
      return;
    }
  }
  // If the file is new, delete the now un-linked
  // file object from MongoDB
  if (fileDat.isNew) {
    File.deleteOne({ localPath: fileDat.path, owner: userId }, err => {
      // nothing is allowed to go wrong here!
      if (err) throw err;
    });
  }
  reject(err);
  if (uploadHandlers.failed) {
    uploadHandlers.failed(fileDat);
  }
  // check if all files in scheduler have failed
  if (!currentSchedule.changed.find(f => f.bytes.failed == 0)) {
    if (uploadHandlers.allFailed) uploadHandlers.allFailed(currentSchedule);
  } else {
    // Move the failed file to the end of the queue
    // (the current file being processed for upload
    // is always the first file in currentSchedule)
    currentSchedule.changed.push(currentSchedule.changed.shift());
  }
  uploading = false;
}

function onUploadComplete(fileDat, data, resolve) {
  let now = new Date().getTime();
  let ipAddress = ip.address("public", "ipv6") || ip.address("public", "ipv4");
  // Update the file doc in MongoDB this
  // verifies the upload completed successfuly
  let fileDoc = {
    idInDatabase: data.fileId,
    nameInDatabase: data.fileName,
    "upload.finished": now,
    binned: false,
    latestSize: data.contentLength,
    "log.lastestSizeCalculationDate": now,
    $push: {
      versions: {
        $each: [
          {
            idInDatabase: data.fileId,
            dateInserted: now,
            originalSize: fileDat.bytes.total
          }
        ],
        $sort: { dateInserted: -1 }
      }
    }
  };
  if (!fileDat.isNew) {
    // insert an update log for restored files
    if (fileDat.binned) {
      fileDoc.$push["log.restoredHistory"] = {
        $each: [
          {
            date: now,
            ipAddress: ipAddress,
            reason: "File detected in file system"
          }
        ],
        $sort: { date: -1 }
      };
    }
    // insert an update log for non-new files
    fileDoc.$push["log.updateHistory"] = {
      $each: [
        {
          date: now,
          ipAddress: ipAddress,
          reason: "Version change detected"
        }
      ],
      $sort: { date: -1 }
    };
  }
  File.findOneAndUpdate(
    { localPath: fileDat.path, owner: userId },
    fileDoc,
    // project the old file to select former latestSize
    { new: false, projection: { _id: 1, block: 1, binned: 1, latestSize: 1 } },
    (err, file) => {
      // nothing is allowed to go wrong here!
      if (err) throw err;
      if (!file) throw new Error("file not set before upload!");
      // asyncronous/syncronous completion based
      // on fileDat.isNew status
      let onComplete = () => {
        fileDat.bytes.done = fileDat.bytes.total;
        fileDat.bytes.failed = 0;
        if (uploadHandlers.success) {
          uploadHandlers.success(fileDat);
        }
        uploading = false;
        resolve();
      };
      Block.findById(file.block, { latestSize: 1 }, (err, block) => {
        // nothing is allowed to go wrong here!
        if (err) throw err;
        let blockDoc = {
          // update file block's latestSize by estimating
          // NOTE: 'file.latestSize' is based on the file size *before* it was updated
          //        see the File.findOneAndUpdate(...) options above
          latestSize:
            block.latestSize -
            (fileDat.isNew ? 0 : file.latestSize) +
            data.contentLength
        };
        if (fileDat.isNew) {
          // update block tracking for new files
          blockDoc.$inc = {
            fileCount: 1
          };
          blockDoc.$push = {
            "log.fileAddHistory": {
              $each: [
                {
                  fileId: file._id,
                  date: now,
                  ipAddress: ipAddress,
                  reason: "Newly detected file in file system"
                }
              ],
              $sort: { date: -1 }
            }
          };
        }
        Block.updateOne({ _id: file.block }, blockDoc, (err, _done) => {
          // nothing is allowed to go wrong here!
          if (err) throw err;
          // complete upload for new&old files
          onComplete();
        });
      });
    }
  );
}

function removeFile(fileDat) {
  return new Promise((resolve, reject) => {
    File.findOne(
      { localPath: fileDat.path, owner: userId },
      { bucket: 1, nameInDatabase: 1 },
      (err, file) => {
        if (err) return reject(err);
        if (!file) {
          return reject(new Error("File not found!"));
        }
        Bucket.findById(file.bucket, { b2_bucket_id: 1 }, (err, bucket) => {
          if (err) return reject(err);
          if (!bucket) {
            return reject(new Error("File's bucket not found!"));
          }
          b2.hideFile({
            bucketId: bucket.b2_bucket_id,
            fileName: file.nameInDatabase
          })
            .then(() => {
              let now = new Date().getTime();
              let ipAddress =
                ip.address("public", "ipv6") || ip.address("public", "ipv4");
              let fileDoc = {
                binned: true,
                $push: {
                  "log.binnedHistory": {
                    $each: [
                      {
                        date: now,
                        ipAddress: ipAddress,
                        reason: "File removed from user's file system"
                      }
                    ],
                    $sort: { date: -1 }
                  }
                }
              };
              File.findOneAndUpdate(
                { localPath: fileDat.path, owner: userId },
                fileDoc,
                (err, file) => {
                  if (err) return reject(err);
                  if (file) {
                    // update block tracking for new files
                    Block.updateOne(
                      { _id: file.block },
                      {
                        $push: {
                          "log.fileBinnedHistory": {
                            $each: [
                              {
                                fileId: file._id,
                                date: now,
                                ipAddress: ipAddress,
                                reason: "File removed from user's file system"
                              }
                            ],
                            $sort: { date: -1 }
                          }
                        }
                      },
                      (err, _done) => {
                        // nothing is allowed to go wrong here!
                        if (err) return reject(err);
                        // complete upload for new files
                        resolve();
                      }
                    );
                  } else {
                    return reject(new Error("Couldn't find file to update!"));
                  }
                }
              );
            })
            .catch(err => reject(err));
        });
      }
    );
  });
}

// upload-service is initialised by the spider
// and is made available through exports.
// This is to ensure there's only 1 running service
module.exports = {
  init,
  initialised: () => initialised,
  pause,
  resume,
  processChanges,
  setUploadHandlers,
  currentSchedule: () => currentSchedule
};
