const fs = require("fs");
const uuidv4 = require("uuid/v4");
const ip = require("ip");
const mime = require("mime-types");
const pathParse = require("path-parse");
const mongoose = require("mongoose");
const checkDiskSpace = require("check-disk-space");

const {
  isLargeFile,
  countPartsForLargeFile,
  clearDir,
  beginSession
} = require("./coordination.js");
const { getB2Key } = require("../security/keyManagement");
const { encryptAndCompress } = require("../security/storeSecure");
const { PROD_DEV_MODE, resolveDir } = require("../prodVariables");

const b2 = new (require("backblaze-b2"))(getB2Key());

const Tier = require("../model/tier");
const Plan = require("../model/plan");
const Bucket = require("../model/bucket");
const Block = require("../model/block");
const File = require("../model/file");

const UPLOAD_DIR = resolveDir("data/upload/schedules");
const HOLD_DIR = resolveDir("data/upload/incomplete");

let currentSchedule;
let paused = true;
let uploading = false;
let processedUpload = true;
let allowProcessing = true;
let waiting = false;
let allowedBlocks = [];
let userId;
let userTier;
var initialised = false;
let isDownloadsPaused;
let isDownloadsWaiting;
let downloadsResume;
let uploadHandlers = {
  resume: null,
  paused: null,
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

/**
 * Initialises the upload-service, resuming uploads,
 * setting state variables, and verifing user's plan status.
 * NOTE: Will reject the promise only if an error occurs or the user's status could not be verified.
 * @param {"ObjectId"} uid
 * @param {"ObjectId"} planId
 * @param {function} downloadsPaused
 * @param {function} downloadsWaiting
 * @param {function} downloadResume
 */
function init(uid, planId, downloadsPaused, downloadsWaiting, downloadResume) {
  return new Promise((resolve, reject) => {
    userId = uid.toString();
    isDownloadsPaused = downloadsPaused;
    isDownloadsWaiting = downloadsWaiting;
    downloadsResume = downloadResume;
    let schedules = [];
    // get saved schedules
    fs.mkdir(UPLOAD_DIR, { recursive: true }, err => {
      if (err) return reject(err);
      fs.readdir(UPLOAD_DIR, { withFileTypes: true }, async (err, files) => {
        if (err) return reject(err);
        files = files.filter(file => file.isFile());
        // finalise if no schedules found
        if (files.length == 0) {
          return finaliseInit(planId, resolve, reject);
        }
        // parse all schedules
        files.forEach(file => {
          schedules.push(
            JSON.parse(fs.readFileSync(`${UPLOAD_DIR}/${file.name}`))
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
        try {
          await removeOutdatedChanges(mergedSchedule.changed);
        } catch (err) {
          return reject(err);
        }
        let onSaved = callback => {
          // once saved, delete all other schedules
          files.forEach(file => fs.unlinkSync(`${UPLOAD_DIR}/${file.name}`));
          // finalise initialisation
          finaliseInit(
            planId,
            () => {
              if (callback) callback();
              resolve();
            },
            reject
          );
        };
        if (
          mergedSchedule.changed.length == 0 &&
          mergedSchedule.removed.length == 0
        ) {
          return onSaved();
        }
        for (let i in mergedSchedule.changed) {
          let change = mergedSchedule.changed[i];
          change.bytes.done = change.bytes.failed = 0;
        }
        saveSchedule(mergedSchedule)
          .then(() => onSaved(() => (currentSchedule = mergedSchedule)))
          .catch(reject);
      });
    });
  });
}

function finaliseInit(planId, resolve, reject) {
  // get user info for use in uploads
  Plan.findById(planId, { expired: 1, tier: 1, blocks: 1 }, (err, plan) => {
    if (err) return reject(err);
    if (!plan || plan.expired) {
      return reject(
        new Error("User doesn't have a plan / user's plan has expired")
      );
    }
    // get user's blocks for use in uploads
    Block.find(
      { _id: { $in: plan.blocks } },
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
              bucket._id = bucket._id.toString();
              allowedBlocks.push({
                _id: block._id.toString(),
                bucket,
                maxSize: block.maxSize
              });
            }
            // get user's plan tier info for version control
            // and archive throttling
            Tier.findById(
              plan.tier,
              { archiveSpeed: 1, fileVersioningAllowed: 1 },
              (err, tier) => {
                if (err) return reject(err);
                if (!tier) return reject(new Error("Failed to load Tier data"));
                userTier = tier;
                clearDir(HOLD_DIR)
                  .catch(err => console.error(err))
                  .then(() => {
                    b2.authorize()
                      .then(() => {
                        initialised = true;
                        resolve();
                      })
                      .catch(reject);
                  });
              }
            );
          }
        ).lean(true);
      }
    );
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
  let mergedSchedule = createBlankSchedule();
  schedules.forEach(schedule => {
    // merge schedules
    mergedSchedule.changed = mergedSchedule.changed.concat(schedule.changed);
    mergedSchedule.removed = mergedSchedule.removed.concat(schedule.removed);
  });
  return mergedSchedule;
}

function createBlankSchedule() {
  return {
    changed: [],
    removed: [],
    created: Date.now()
  };
}

/**
 * This function will query if the user's plan has expired.
 * If it has, future processing will be blocked and the promise rejected.
 * Otherwise, the promise will resolve.
 * NOTE: the function will also block processing if an error occurs
 */
function verifyPlanNotExpired() {
  return new Promise((resolve, reject) => {
    Plan.findOne({ owner: userId, expired: false }, { _id: 1 }, (err, plan) => {
      if (err) {
        allowProcessing = false;
        return reject(err);
      }
      if (!plan) {
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
  return new Promise((resolve, reject) => {
    if (!allowProcessing) {
      return reject({
        msg: "Processing has been disabled. Possible plan expiry",
        processingBlocked: true
      });
    }
    if (changes.length == 0 && removed.length == 0) {
      return resolve();
    }
    // wait for current upload to settle
    pause()
      .then(async () => {
        if (PROD_DEV_MODE) {
          console.log("upload processing");
        }
        // build new schedule based on updates
        let uploadSchedule = {
          changed: changes,
          removed: removed,
          created: Date.now()
        };
        let oldSize = uploadSchedule.changed.length;
        try {
          await removeOutdatedChanges(uploadSchedule.changed);
        } catch (err) {
          // if an error occurs, we must report the operation as failed
          return reject(err);
        }
        if (
          PROD_DEV_MODE &&
          oldSize > 0 &&
          oldSize != uploadSchedule.changed.length
        ) {
          console.log(
            `skipped ${Math.abs(
              oldSize - uploadSchedule.changed.length
            )} file(s)`
          );
        }
        if (changes.length == 0 && removed.length == 0) {
          return resolve();
        }
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
              if (
                uploadSchedule.changed.length > 0 ||
                uploadSchedule.removed.length > 0
              ) {
                resume().catch(reject);
              }
              resolve();
            })
            .catch(reject);
        };
        // merge current and upload schedules
        // only if the currentSchedule exists
        // (typically during the first cycle)
        if (currentSchedule) {
          // apply mergedSchedule
          let mergedSchedule = mergeSchedules([
            uploadSchedule,
            currentSchedule
          ]);
          clearOtherSchedules(mergedSchedule)
            .then(() => onMerged(mergedSchedule))
            .catch(reject);
        } else {
          // if currentSchedule doesn't exist
          // apply uploadSchedule immediately
          onMerged(uploadSchedule);
        }
      })
      .catch(reject);
  });
}

/**
 * Checks all files with MongoDB and splices the outdated changes
 * @param {["FileDat"]} changes
 */
async function removeOutdatedChanges(changes) {
  for (let i = 0; i < changes.length; i++) {
    let c = changes[i];
    let newer = await changeIsNewer(c.path, c.modified);
    if (!fs.existsSync(c.path) || !newer) {
      changes.splice(i, 1);
      i--;
    }
  }
}

function changeIsNewer(localPath, modifiedTime) {
  return new Promise((resolve, reject) => {
    File.findOne(
      {
        localPath: localPath,
        owner: userId,
        $and: [
          { idInDatabase: { $ne: "unset" } },
          { idInDatabase: { $ne: "deleted" } }
        ]
      },
      { "log.lastModifiedTime": 1 },
      (err, file) => {
        if (err) return reject(err);
        if (!file || !file.log.lastModifiedTime) {
          resolve(true);
        } else {
          resolve(modifiedTime > file.log.lastModifiedTime);
        }
      }
    );
  });
}

/**
 * Attaches upload handlers. Will replace any old handlers
 * @param {Object<string, function>} handlers
 */
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
    `${UPLOAD_DIR}/schedule_${schedule.created}.json`,
    JSON.stringify(schedule)
  );
}

function removeScheduleSync(schedule) {
  fs.unlinkSync(`${UPLOAD_DIR}/schedule_${schedule.created}.json`);
}

function clearOtherSchedules(schedule) {
  return new Promise((resolve, reject) => {
    try {
      if (!schedule) schedule = {};
      let goalName = `schedule_${schedule.created}.json`;
      let files = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
      for (let i in files) {
        let file = files[i];
        if (!file.isFile()) continue;
        if (file.name != goalName) {
          fs.unlinkSync(`${UPLOAD_DIR}/${file.name}`);
        }
      }
    } catch (err) {
      return reject(err);
    }
    resolve();
  });
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
        if (uploadHandlers.paused) {
          uploadHandlers.paused();
        }
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
    if (!isDownloadsPaused()) {
      waiting = true;
      return reject("Resume blocked. Download-service still busy");
    }
    waiting = false;
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
        console.log("upload [all completed]!");
        if (uploadHandlers.allUploaded) {
          uploadHandlers.allUploaded(currentSchedule);
        }
        removeScheduleSync(currentSchedule);
        currentSchedule = null;
        paused = true;
        // verify the user's plan hasn't epired
        // if it has block future processing
        return verifyPlanNotExpired()
          .catch(err => console.error(err)) // errors aren't a worry here
          .then(resolve);
      }
      // check if all uploads/removals have failed
      // NOTE if some removals are left, failed uploads might be retried and vice versa
      // NOTE on restart, all failed tasks WILL be retried
      if (
        (currentSchedule.changed.length > 0 &&
          !currentSchedule.changed.find(
            f => f.bytes.failed == 0 || f.pendingRetry
          )) ||
        (currentSchedule.removed.length > 0 &&
          !currentSchedule.removed.find(f => !f.failed))
      ) {
        console.log("all uploads failed");
        clearInterval(task);
        return verifyPlanNotExpired()
          .catch(err => console.error(err)) // errors aren't a worry here
          .then(resolve);
      }
      // only begin uploading if not currently working
      if (!uploading && processedUpload) {
        // check if throttling is necessary
        // 'now' is measured in seconds
        let now = Math.floor(Date.now() / 1000);
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
          // process changed files
          if (currentSchedule.changed.length > 0) {
            let nextChange = currentSchedule.changed[0];
            console.log("nextUpload > " + pathParse(nextChange.path).name);
            attachHandlersAndExecute(
              {
                item: nextChange,
                function: isLargeFile(nextChange)
                  ? uploadLargeFile
                  : uploadSmallFile
              },
              true
            );
          }
          // process removed files
          if (currentSchedule.removed.length > 0) {
            let nextRemoval = currentSchedule.removed[0];
            console.log("nextRemoval > " + pathParse(nextRemoval.path).name);
            attachHandlersAndExecute({
              item: nextRemoval,
              function: removeFile
            });
          }
          /**
           * Attaches handlers for and keeps track of the promises
           * @param {{item: "FileDat", function: Function<Promise>}} holder
           */
          function attachHandlersAndExecute(holder, allowResetBytes) {
            if (allowResetBytes && holder.item.bytes) {
              holder.item.bytes.done = 0;
              holder.item.bytes.failed = 0;
            }
            let removeChange = path => {
              return currentSchedule.changed.splice(
                currentSchedule.changed.findIndex(f => f.path == path),
                1
              )[0];
            };
            let promise = holder.function(holder.item);
            delete holder.function;
            promises.push(holder);
            promise
              // mark the promise as settled
              .finally(() => (holder.settled = true))
              // catch and log errors
              .catch(err => {
                //NOTE use this to stop when an error occurs
                // paused = true;
                // this ^
                try {
                  console.error(err.response.data);
                } catch (error) {
                  console.error(err);
                }
                if (holder.item.bytes) {
                  holder.item.bytes.failed = holder.item.bytes.total;
                  holder.item.bytes.done = 0;
                  currentSchedule.changed.push(removeChange(holder.item.path));
                } else {
                  holder.item.failed = true;
                  currentSchedule.removed.push(currentSchedule.removed.shift());
                }
              })
              .then(() => {
                //remove successfull uploads from the schedule
                if (holder.item.bytes) {
                  // [not anymore] done+failed bytes must exactly match total size to be successful
                  //         holder.item.bytes.failed == 0 &&
                  //           holder.item.bytes.done + holder.item.bytes.failed ==
                  //             holder.item.bytes.total
                  if (holder.item.bytes.done == holder.item.bytes.total) {
                    console.log("upload confirmed successful");
                    removeChange(holder.item.path);
                    // increment throttler after the successful upload
                    throttler.periodGbs += holder.item.bytes.total / 1073741824;
                  } else {
                    console.log("upload incomplete!");
                  }
                } else if (!holder.item.failed) {
                  currentSchedule.removed.shift();
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
                saveSchedule(currentSchedule).catch(err => console.error(err));
              });
          }
        });
      }
    }, 3000);
  }).then(async () => {
    if (currentSchedule) {
      try {
        await removeOutdatedChanges(currentSchedule.changed);
        if (
          currentSchedule.changed.length > 0 ||
          currentSchedule.removed.length > 0
        ) {
          saveScheduleSync(currentSchedule);
        } else {
          removeScheduleSync(currentSchedule);
          currentSchedule = null;
        }
      } catch (err) {
        console.error(err);
      }
    }
    if (isDownloadsWaiting()) {
      console.log("Download-service was waiting");
      downloadsResume().catch(err => {
        console.log("resume was blocked!\n", err);
      });
    }
  });
}

function randomFileName() {
  let name = "unversioned/";
  if (userTier.fileVersioningAllowed) {
    name = "versioned/";
  }
  name += `${userId}/${uuidv4()}`;
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
  //jshint ignore:start
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
            "versions.count": 1,
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
                  version: file.versions.count + 1,
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
          if (err) return reject(err);
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
                  `Block ${block._id} has corrupted latestSize and/or maxSize fields!`
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
                beginSession()
                  .then(session => {
                    // subtract the found block's maxSize by fileUpdateOverhead
                    Block.updateOne(
                      { _id: blocks[0]._id },
                      { $inc: { maxSize: -fileUpdateOverhead } },
                      { session }
                    );
                    // add extra space to the current file block
                    Block.updateOne(
                      { _id: fileBlock.block },
                      { $inc: { maxSize: fileUpdateOverhead } },
                      { session }
                    );
                    session
                      .commitTransaction()
                      .then(() => resolve(fileBlock))
                      .catch(err => {
                        new Error(
                          "Failed to allocate more space in the block for the file update",
                          err
                        );
                      });
                  })
                  .catch(err => {
                    new Error(
                      "Failed to allocate more space in the block for the file update",
                      err
                    );
                  });
              }
            );
          } else {
            resolve(fileBlock);
          }
        }
      );
    }
  });
  //jshint ignore:end
}

function preUpload(fileDat) {
  return new Promise((resolve, reject) => {
    beginSession()
      .then(session => {
        selectUploadBlock(fileDat)
          .then(fileBlock => {
            console.log(fileBlock);
            let now = Date.now();
            // Define file object now to use less
            // internet after upload complete
            // to ensure MongoDB integrity
            let fileDoc = {
              "upload.started": now,
              $unset: {
                "upload.paused": "",
                "upload.finished": ""
              },
              download: {},
              pendingDeletion: false,
              deleted: false
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
              fileDoc.bucket = fileBlock.bucket._id;
              fileDoc.originalSize = fileDat.bytes.total;
              fileDoc["log.detected"] = now;
            }
            // Update the file's details, creating
            // a new one if none is found
            File.updateOne(
              { localPath: fileDat.path, owner: userId },
              fileDoc,
              { upsert: true, setDefaultsOnInsert: true },
              (err, _done) => {
                if (err) {
                  uploading = false;
                  return reject(err);
                }
                resolve([session, fileBlock]);
              }
            );
          })
          .catch(err => {
            uploading = false;
            reject(err);
          });
      })
      .catch(reject);
  });
}

function uploadSmallFile(fileDat) {
  return new Promise((resolve, reject) => {
    uploading = true;
    console.log("upload small file beginning");
    preUpload(fileDat)
      .then(uploadInfo => {
        let fileBlock = uploadInfo[1];
        b2.getUploadUrl(fileBlock.bucket.b2_bucket_id)
          .then(({ data }) => {
            encryptAndCompress(fs.createReadStream(fileDat.path), userId)
              .then(fileBuffer => {
                let initVect = fileBuffer[0];
                fileBuffer = fileBuffer[1];
                b2.uploadFile({
                  uploadUrl: data.uploadUrl,
                  uploadAuthToken: data.authorizationToken,
                  fileName: fileBlock.nameInDatabase,
                  mime: mime.lookup(fileDat.path),
                  data: fileBuffer,
                  info: {
                    "src-last-modified-millis": new Date(
                      fileDat.modified
                    ).getTime()
                  },
                  onUploadProgress: e => onUploadProgress(fileDat, e)
                })
                  .then(({ data }) =>
                    onUploadComplete(
                      fileDat,
                      data,
                      initVect,
                      uploadInfo[0],
                      resolve,
                      reject
                    )
                  )
                  .catch(err =>
                    onUploadFail(fileDat, err, uploadInfo[0], resolve, reject)
                  );
              })
              .catch(err =>
                onUploadFail(fileDat, err, uploadInfo[0], resolve, reject)
              );
          })
          .catch(err => {
            fileDat.failedOnUrl = true;
            onUploadFail(fileDat, err, uploadInfo[0], resolve, reject);
          });
      })
      .catch(reject);
  });
}

function uploadLargeFile(fileDat) {
  return new Promise((resolve, reject) => {
    uploading = true;
    console.log("upload large file beginning");
    preUpload(fileDat)
      .then(uploadInfo => {
        let fileBlock = uploadInfo[1];
        b2.startLargeFile({
          bucketId: fileBlock.bucket.b2_bucket_id,
          fileName: fileBlock.nameInDatabase || randomFileName(),
          contentType: mime.lookup(fileDat.path)
        })
          .then(async ({ data }) => {
            //define fail handler
            let onFail = err => {
              onUploadFail(fileDat, err, uploadInfo[0], resolve, reject);
            };
            try {
              let diskSpace = await checkDiskSpace(
                pathParse(fileDat.path).root
              );
              if (diskSpace.free < fs.statSync(fileDat.path).size * 1.1) {
                return onFail(
                  new Error(
                    "large file cannot be uploaded due to insufficient space"
                  )
                );
              }
            } catch (err) {
              return onFail(err);
            }
            // encrypt and hold the file in a private location
            // this is so we can accurately decrypt the file later
            let heldFilePath;
            let fileDescriptor;
            let initVect;
            try {
              console.log("holding large file..");
              let encryptInfo = await holdEncryptedFile(fileDat);
              initVect = encryptInfo[0];
              heldFilePath = encryptInfo[1];
              // open held file for upload
              fileDescriptor = fs.openSync(heldFilePath, "r");
            } catch (err) {
              return onFail(err);
            }
            // calculate the dimentions of each part relative
            // to the encrypted file size
            let heldPromises = [];
            let fileDataSize = fs.statSync(heldFilePath).size;
            // calculate part sizes
            console.log("large file length", fileDataSize);
            let partsCount = countPartsForLargeFile({ size: fileDataSize });
            console.log("large file partsCount", partsCount);
            let partWidth = Math.ceil(fileDataSize / partsCount);
            console.log("large file partWidth", partWidth);
            var partSha1Array = new Array(partsCount);
            // generate promises for each part
            // and begin executing them
            fileDat.parts = new Array(partsCount - 1);
            for (let i = 0; i < partsCount; i++) {
              // promise starts after a relative delay
              // this is to avoid overloaing the b2 database
              let partStart = i * partWidth;
              heldPromises.push(
                holdPartPromise(
                  i + 1,
                  partStart,
                  Math.min(partWidth, fileDataSize - partStart)
                )
              );
            }
            // sequentially execute each part promise
            let aPartFailed = false;
            while (heldPromises.length > 0 && !aPartFailed) {
              try {
                await heldPromises.shift()(fileDescriptor);
              } catch (err) {
                onFail(err);
                aPartFailed = true;
                // close the file when any part fails
                try {
                  fs.closeSync(fileDescriptor);
                  // cleanup held file
                  fs.unlinkSync(heldFilePath);
                } catch (err2) {}
                return;
              }
            }
            // close the file once uploaded
            try {
              fs.closeSync(fileDescriptor);
              fs.unlinkSync(heldFilePath);
            } catch (err) {}
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
            console.log("SHA1 key length", partSha1Array.length);
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
                onUploadComplete(
                  fileDat,
                  data,
                  initVect,
                  uploadInfo[0],
                  resolve,
                  reject
                );
              })
              .catch(err => {
                // upload might have finished
                // we need to confirm (after 5 seconds)
                console.log("checking upload status..");
                setTimeout(() => {
                  b2.getFileInfo(data.fileId)
                    .then(({ data }) =>
                      onUploadComplete(
                        fileDat,
                        data,
                        initVect,
                        uploadInfo[0],
                        resolve,
                        reject
                      )
                    )
                    .catch(err => onFail(err));
                }, 5000);
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
              return fileDescriptor => {
                // init progress tracker before starting
                let partProgress = (fileDat.parts[partNumber - 1] = {
                  number: partNumber,
                  start: partStart,
                  length: partLength,
                  bytes: {}
                });
                saveScheduleSync(currentSchedule);
                let fileBuffer;
                let retried = false;
                let partPromise = () =>
                  new Promise((resolve, reject) => {
                    setTimeout(() => {
                      b2.getUploadPartUrl({
                        fileId: data.fileId
                      })
                        .then(({ data }) => {
                          console.log(partNumber, "got url");
                          console.log(partNumber, "allocating", partLength);
                          fileBuffer = Buffer.alloc(partLength);
                          console.log(
                            partNumber,
                            "reading",
                            `[${partStart} >> ${partStart + partLength})`
                          );
                          fs.readSync(
                            fileDescriptor,
                            fileBuffer,
                            0,
                            partLength,
                            partStart
                          );
                          console.log(partNumber, "uploading", partLength);
                          b2.uploadPart({
                            partNumber: partNumber,
                            uploadUrl: data.uploadUrl,
                            uploadAuthToken: data.authorizationToken,
                            data: fileBuffer,
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
                            .catch(err => {
                              console.log(err);
                              if (
                                !retried &&
                                err &&
                                err.data &&
                                err.data.status == 503
                              ) {
                                console.log(
                                  "b2 is busy, waiting 5 seconds to try again..."
                                );
                                setTimeout(() => {
                                  retried = true;
                                  fileBuffer = null;
                                  partPromise()
                                    .then(resolve)
                                    .catch(reject);
                                }, 5000);
                              } else {
                                reject(err);
                              }
                            });
                        })
                        .catch(err => {
                          console.log(partNumber, "part failed");
                          fileDat.failedOnUrl = true;
                          reject(err);
                        });
                    }, 5000);
                  });
                return partPromise();
              };
            }
          })
          .catch(err =>
            onUploadFail(fileDat, err, uploadInfo[0], resolve, reject)
          );
      })
      .catch(reject);
  });
}

function holdEncryptedFile(fileDat) {
  return new Promise((resolve, reject) => {
    fs.mkdir(HOLD_DIR, { recursive: true }, err => {
      if (err) return reject(err);
      let heldFilePath = `${HOLD_DIR}/${
        pathParse(fileDat.path).base
      }.incomplete`;
      encryptAndCompress(
        fs.createReadStream(fileDat.path),
        userId,
        fs.createWriteStream(heldFilePath)
      )
        .then(initVect => resolve([initVect, heldFilePath]))
        .catch(reject);
    });
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

/**
 * Handles failed uploads
 * @param {"FileDat"} fileDat
 * @param {Error} err
 * @param {mongoose.ClientSession} session
 * @param {Function} resolve
 * @param {Function} reject
 */
function onUploadFail(fileDat, err, session, resolve, reject) {
  try {
    session.abortTransaction();
  } catch (err2) {}
  fileDat.bytes.failed = fileDat.bytes.total - fileDat.bytes.done;
  // Retry the upload *once* if BackBlaze failed
  // to provide an upload URL.
  // (All other errors are valid.)
  if (fileDat.failedOnUrl && !fileDat.retried) {
    fileDat.pendingRetry = true;
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
    // errors are ignored because the garbage collector
    // will clean it up
    File.deleteOne({ localPath: fileDat.path, owner: userId }, err => {});
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

/**
 * Handles successful uploads
 * @param {"FileDat"} fileDat
 * @param {"B2 FileInfo"} data
 * @param {Buffer} initVect
 * @param {mongoose.ClientSession} session
 * @param {Function} resolve
 * @param {Function} reject
 */
function onUploadComplete(fileDat, data, initVect, session, resolve, reject) {
  let now = Date.now();
  let ipAddress = ip.address("public", "ipv6") || ip.address("public", "ipv4");
  // Update the file doc in MongoDB this
  // verifies the upload completed successfuly
  console.log(data.fileName, "fileDat.size", fileDat.size, "isNew", !!fileDat.isNew);
  let fileDoc = {
    idInDatabase: data.fileId,
    nameInDatabase: data.fileName,
    "upload.finished": now,
    binned: false,
    latestSize: fileDat.size,
    "log.lastestSizeCalculationDate": now,
    "log.lastModifiedTime": fileDat.modified,
    $push: {
      "versions.list": {
        $each: [
          {
            idInDatabase: data.fileId,
            dateInserted: now,
            originalSize: fileDat.size,
            initVect
          }
        ],
        $sort: { dateInserted: -1 }
      },
      "log.sizeHistory.list": {
        $each: [
          {
            date: now,
            size: fileDat.bytes.total
          }
        ],
        $sort: { date: -1 }
      }
    },
    $inc: {
      "versions.count": 1,
      "versions.activeCount": 1,
      "log.sizeHistory.count": 1
    }
  };
  if (!fileDat.isNew) {
    // insert an update log for restored files
    if (fileDat.binned) {
      fileDoc.$push["log.restoredHistory.list"] = {
        $each: [
          {
            date: now,
            ipAddress: ipAddress,
            reason: "File detected in file system"
          }
        ],
        $sort: { date: -1 }
      };
      fileDoc.$inc["log.restoredHistory.count"] = 1;
    }
    // insert an update log for non-new files
    fileDoc.$push["log.updateHistory.list"] = {
      $each: [
        {
          date: now,
          ipAddress: ipAddress,
          reason: "Version change detected"
        }
      ],
      $sort: { date: -1 }
    };
    fileDoc.$inc["log.updateHistory.count"] = 1;
  }
  let fileInMongoDB;
  let blockDoc;
  File.findOne(
    { localPath: fileDat.path, owner: userId },
    { _id: 1, block: 1, binned: 1, latestSize: 1 }
  )
    .then(file => (fileInMongoDB = file))
    .then(() =>
      File.updateOne({ localPath: fileDat.path, owner: userId }, fileDoc, {
        session
      })
    )
    .then(() => {
      if (!fileInMongoDB) throw new Error("file not set before upload!");
      // console.log("file(mongo)", JSON.stringify(fileInMongoDB));
      blockDoc = {
        // update file block's latestSize based on the file's size *before*
        // it was updated. See the File.findOneAndUpdate(...) options above
        $inc: {
          latestSize:
            (fileDat.isNew ? 0 : -fileInMongoDB.latestSize || 0) + fileDat.size
        }
      };
      if (fileDat.isNew) {
        // update block tracking for new files
        blockDoc.$inc.fileCount = 1;
        blockDoc.$push = {
          "log.fileAddHistory.list": {
            $each: [
              {
                fileId: fileInMongoDB._id,
                date: now,
                ipAddress: ipAddress,
                reason: "Newly detected file in file system"
              }
            ],
            $sort: { date: -1 }
          }
        };
        blockDoc.$inc["log.fileAddHistory.count"] = 1;
      }
      // console.log(JSON.stringify(blockDoc));
    })
    .then(() =>
      Block.updateOne({ _id: fileInMongoDB.block }, blockDoc, { session })
    )
    .then(() =>
      session
        .commitTransaction()
        .then(() => {
          console.log("marking upload as successful");
          fileDat.bytes.done = fileDat.bytes.total;
          fileDat.bytes.failed = 0;
          if (uploadHandlers.success) {
            uploadHandlers.success(fileDat);
          }
          uploading = false;
          resolve();
        })
        .catch(rejectOperation)
    )
    .catch(rejectOperation);
  function rejectOperation(err) {
    console.error(err);
    fileDat.bytes.failed = fileDat.bytes.total;
    fileDat.bytes.done = 0;
    fileDat.retried = true;
    console.log("\nWaiting 5 seconds to delete version from b2\n");
    setTimeout(() => {
      b2.deleteFileVersion({
        fileName: fileDoc.nameInDatabase,
        fileId: fileDoc.idInDatabase
      })
        .catch(err => console.error(err))
        .finally(() => onUploadFail(fileDat, err, session, resolve, reject));
    }, 5000);
  }
}

function removeFile(fileDat) {
  return new Promise((resolve, reject) => {
    beginSession()
      .then(session => {
        File.findOne(
          { localPath: fileDat.path, owner: userId },
          { bucket: 1, nameInDatabase: 1 },
          (err, file) => {
            if (err) return reject(err);
            if (!file) {
              return reject(new Error("File not found!"));
            }
            Bucket.findOne(
              { _id: file.bucket },
              { b2_bucket_id: 1 },
              (err, bucket) => {
                if (err) return reject(err);
                if (!bucket) {
                  return reject(new Error("File's bucket not found!"));
                }
                b2.hideFile({
                  bucketId: bucket.b2_bucket_id,
                  fileName: file.nameInDatabase
                })
                  .then(() => {
                    let now = Date.now();
                    let ipAddress =
                      ip.address("public", "ipv6") ||
                      ip.address("public", "ipv4");
                    let fileDoc = {
                      binned: true,
                      $push: {
                        "log.binnedHistory.list": {
                          $each: [
                            {
                              date: now,
                              ipAddress: ipAddress,
                              reason: "File removed from user's file system"
                            }
                          ],
                          $sort: { date: -1 }
                        }
                      },
                      $inc: {
                        "log.binnedHistory.count": 1
                      }
                    };
                    File.updateOne(
                      { localPath: fileDat.path, owner: userId },
                      fileDoc,
                      { session }
                    );
                    Block.updateOne(
                      { _id: file.block },
                      {
                        $push: {
                          "log.fileBinnedHistory.list": {
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
                        },
                        $inc: {
                          "log.fileBinnedHistory.count": 1
                        }
                      },
                      { session }
                    );
                    session
                      .commitTransaction()
                      .then(resolve)
                      .catch(reject);
                  })
                  .catch(reject);
              }
            );
          }
        );
      })
      .catch(reject);
  });
}

// upload-service is initialised by the spider
// and is made available through exports.
// This is to ensure there's only 1 running service
module.exports = {
  init,
  isInitialised: () => initialised,
  pause,
  isPaused: () => paused,
  resume,
  isWaiting: () => waiting,
  processChanges,
  setUploadHandlers,
  getCurrentSchedule: () => currentSchedule
};
