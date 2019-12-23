const fs = require("fs");
const pathParse = require("path-parse");
const ip = require("ip");
const { PROD_DEV_MODE, resolveDir } = require("../prodVariables");
const { normalisePath } = require("./coordination");

var File = require("../model/file");
var uploadService;

let uid;
let planId;
var directoryStore;
let firstDelay;
let taskDelay;
let process;
let processing = false;
let wasCancelled = false;
let initialised = false;

/**
 * Initialises the spider
 * @param {Object<string, any>} options
 * @throws an error if already initialised
 */
function init(options) {
  return new Promise((resolve, reject) => {
    if (initialised) {
      return reject(new Error("Spider already initialised"));
    }
    setImmediate(() => {
      checkOptions(options, [
        "uid",
        "planId",
        "firstDelay",
        "taskDelay",
        "uploadService"
      ]);
      uid = options.uid.toString();
      planId = options.planId.toString();
      firstDelay = options.firstDelay;
      taskDelay = options.taskDelay;
      uploadService = options.uploadService;
      // pull the directory store if it did not already
      // exist locally
      directoryStore = saveDirectoryStore(true);
      if (directoryStore) {
        pullDirectoryStore()
          .then(finialiseInit)
          .catch(reject);
      } else {
        readDirectoryStore();
        if (directoryStore.uid != uid || directoryStore.planId != planId) {
          directoryStore = resetDirectoryStore();
          pullDirectoryStore()
            .then(finialiseInit)
            .catch(reject);
        } else {
          finialiseInit();
        }
      }
      function finialiseInit() {
        resolve({
          isRunning: () => processing,
          startTask,
          cancelTask,
          wasCancelled,
          readOnlyDirectoryStore: () => {
            if (!directoryStore) readDirectoryStore();
            return Object.assign({}, directoryStore);
          },
          pullDirectoryStore,
          directoryIsSelected,
          fileIsSelected,
          selectDirectory,
          selectFile,
          saveDirectoryStore
        });
      }
    });
  });
}

function directoryIsSelected(path) {
  return !!directoryStore.active.find(d => d.path == normalisePath(path));
}

function fileIsSelected(path) {
  path = normalisePath(path);
  let dirPath = pathParse(path).dir;
  let dir = directoryStore.active.find(d => d.path == dirPath);
  if (!dir) return false;
  let file = dir.files.find(f => f.path == path);
  return !!file && !file.ignored;
}

function selectDirectory(path, include, doNotSave) {
  checkOptions({ path, include }, ["path", "include"]);
  path = normalisePath(path);
  if (!fs.existsSync(path) && include) {
    throw new Error("path doesn't exist");
  }
  // load up the current directory store
  if (!directoryStore) readDirectoryStore();
  // look for a matching directory
  let directoryIndex = directoryStore.active.findIndex(d => d.path == path);
  if (include) {
    // if you want to include and a match wasn't found
    // add a new one to the active list
    if (directoryIndex < 0) {
      directoryStore.active.push({
        path: path,
        files: []
      });
    }
  } else if (directoryIndex >= 0) {
    // if you want to ignore and a match was found
    // move the match to ignored
    let directory = directoryStore.active.splice(directoryIndex, 1);
    // set an ignored date for future complete removal
    directory.ignoredOn = Date.now();
  }
  if (!doNotSave) saveDirectoryStore();
}

function selectFile(path, include) {
  return new Promise(async (resolve, reject) => {
    try {
      checkOptions({ path, include }, ["path", "include"]);
      path = normalisePath(path);
      if (!fs.existsSync(path) && include) {
        throw new Error("path doesn't exist");
      }
      // load the current directory store
      if (!directoryStore) readDirectoryStore();
      let dirPath = pathParse(path).dir;
      let directoryIndex = directoryStore.active.findIndex(
        d => d.path == dirPath
      );
      if (include) {
        let file = {
          path: path,
          mtimeMs: fs.statSync(path).mtimeMs, // is corrected below
          ignored: false,
          detected: Date.now()
        };
        // if you want to include and the corresponding folder
        // was not found, insert one (including the new file)
        if (directoryIndex < 0) {
          directoryStore.active.push({
            path: path,
            files: [file]
          });
        } else {
          let storedFileIndex = directoryStore.active[
            directoryIndex
          ].files.findIndex(f => f.path == path);
          if (storedFileIndex < 0) {
            // if the corresponding folder was found and a matching file
            // was not found, insert the new file
            directoryStore.active[directoryIndex].files.push(file);
          } else {
            await File.updateOne(
              {
                owner: uid,
                localPath:
                  directoryStore.active[directoryIndex].files[storedFileIndex]
                    .path
              },
              { ignored: false }
            ).then();
            directoryStore.active[directoryIndex].files[
              storedFileIndex
            ].ignored = false;
          }
        }
      } else if (directoryIndex >= 0) {
        // only continues if you want to ignore and the
        // corresponding folder was found
        let fileIndex = directoryStore.active[directoryIndex].files.findIndex(
          f => f.path == path
        );
        if (fileIndex >= 0) {
          // if a matching file was found, ignore it
          await File.updateOne(
            {
              owner: uid,
              localPath:
                directoryStore.active[directoryIndex].files[fileIndex].path
            },
            { ignored: true }
          ).then();
          directoryStore.active[directoryIndex].files[fileIndex].ignored = true;
        }
      }
      saveDirectoryStore();
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function startTask(skipFirstDelay) {
  checkOptions({ uid }, ["uid"]);
  return new Promise((resolve, reject) => {
    // clear running process
    // NOTE: upload processes may still be running!
    cancelTask();
    // check upload-service is initialised
    if (!uploadService.isInitialised()) {
      return reject("upload-service not initialised");
    } else {
      // start spider process
      setTimeout(
        () => {
          if (!skipFirstDelay) {
            // run first task
            setImmediate(task);
          }
          process = setInterval(task, taskDelay);
        },
        skipFirstDelay ? 0 : firstDelay
      );
      console.log("Spider was started");
      resolve();
    }
  });
}

function cancelTask() {
  if (process) {
    process = clearInterval(process);
    console.log("Spider was stopped");
  }
  // prevent spawning of a new process
  // (this is more of a fail-safe)
  wasCancelled = false;
}

function task() {
  // console.log("spider spawned");
  // don't resume process if one is already running
  if (processing) {
    cancelTask();
    // inform current process a new one is waiting
    wasCancelled = true;
    return;
  }
  // inform future processes we are busy
  processing = true;
  // console.log(" - spider processing");
  let changed = [];
  let removed = [];
  let now = Date.now();
  // ignore non-existant directories
  directoryStore.active = directoryStore.active.filter(directory => {
    if (!fs.existsSync(directory.path)) {
      // set an ignored date for future complete removal
      directory.ignoredOn = now;
      directoryStore.ignore.push(directory);
      return false;
    } else return true;
  });
  // re-activate ignored directories that re-appear within a week
  const WEEK_MILLS = 6048000000;
  directoryStore.ignore = directoryStore.ignore.filter(directory => {
    if (fs.existsSync(directory.path)) {
      // clear ignored date for the found directory
      delete directory.ignoredOn;
      directoryStore.active.push(directory);
      return false;
    } else if (now > directory.ignoredOn + WEEK_MILLS) {
      // completely remove directories that have been
      // ignored for over a week
      return false;
    } else return true;
  });
  // we only process active directories
  directoryStore.active.forEach(directory => {
    let files = fs.readdirSync(directory.path, { withFileTypes: true });
    // iterate through file-system files
    for (let i in files) {
      const ent = files[i];
      // skip non-'file' files
      if (!ent.isFile()) continue;
      const filePath = `${directory.path}/${ent.name}`;
      let stat = fs.statSync(filePath);
      let storedDat = directory.files.find(v => v.path == filePath);
      // if no stored info on this file, push a new one
      if (!storedDat) {
        directory.files.push(
          (storedDat = {
            path: filePath,
            mtimeMs: 0, // is corrected below
            ignored: false,
            detected: Date.now()
          })
        );
      }
      // skip if file is ignored
      // (absolutely won't skip if file's new)
      if (storedDat.ignored) continue;
      // if (stat.mtimeMs > storedDat.mtimeMs) {
      // ^ This has been removed to ensure changes are always checked with the backend

      // declare a changed file
      changed.push({
        directory: directory.path,
        path: filePath,
        modified: stat.mtimeMs,
        size: stat.size,
        bytes: {
          total: stat.size,
          done: 0,
          failed: 0
        }
      });

      // update stored modified time
      // NOTE: this doesn't guarantee a
      //  fully processed update
      storedDat.mtimeMs = stat.mtimeMs;
    }
    // search for stored files that
    // no longer exist in file system
    directory.files.forEach(file => {
      if (
        !files.find(ent => {
          return `${directory.path}/${ent.name}` == file.path;
        })
      ) {
        // declare a removed file
        removed.push({
          directory: directory.path,
          path: file.path,
          detected: Date.now()
        });
        // remove the file from the directoryStore
        directory.files.splice(
          directory.files.findIndex(f => f.path == file.path),
          1
        );
      }
    });
  });
  // save directory store to keep discoveries before processing
  saveDirectoryStore();
  if (changed.length == 0 && removed.length == 0) {
    processing = false;
    if (wasCancelled) {
      wasCancelled = false;
      startTask();
    }
    return;
  }
  // process declared changes/removals
  if (PROD_DEV_MODE) {
    console.log("spider > upload-service");
  }
  uploadService
    .processChanges(changed, removed)
    .then(() => {
      if (PROD_DEV_MODE) {
        console.log("spider > upload-service (done)");
      }
      processing = false;
      if (wasCancelled) {
        wasCancelled = false;
        startTask();
      }
    })
    .catch(err => {
      let allowRestartSpider = true;
      if (err) {
        console.error(err);
        if (err.processingBlocked) {
          // NOTE add a service that will notify when the spider cannot continue
          // NOTE spider will stop forever if processing
          // was blocked. Client will need to restart it
          // (usually after plan renewal)
          cancelTask();
          allowRestartSpider = false;
        }
      }
      processing = false;
      if (allowRestartSpider) {
        if (wasCancelled) {
          wasCancelled = false;
          startTask();
        }
      }
    });
}

/**
 * Pulls the cloud directory store by parsing file objects
 * assigned to the user with assigned (uid)
 */
function pullDirectoryStore() {
  checkOptions({ uid }, ["uid"]);
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      let sentResponse = false;
      File.find(
        { owner: uid },
        {
          localPath: 1,
          ignored: 1,
          binned: 1,
          "log.detected": 1,
          "log.lastModifiedTime": 1
        }
      )
        .cursor()
        .on("error", err => reject(err))
        .on("data", file => {
          try {
            const path = normalisePath(pathParse(file.localPath));
            if (!fs.existsSync(file.localPath)) {
              if (!file.binned) {
                processBinned(file.localPath);
                file.binned = true;
              }
            }
            let dir;
            // search for directory in store, pushing
            // a new (active) entry if not found
            if (
              !(dir =
                directoryStore.ignore.find(d => d.path == path.dir) ||
                directoryStore.active.find(d => d.path == path.dir))
            ) {
              dir = {
                path: path.dir,
                files: []
              };
              directoryStore.active.push(dir);
            }
            let storedFile = dir.files.find(f => f.path == file.localPath);
            if (!storedFile) {
              storedFile = {
                path: file.localPath
              };
              // don't worry, js keeps (storedFile) referenced
              // in the (dir) object, so updates will persist
              dir.files.push(storedFile);
            }
            storedFile.ignored = !!file.ignored;
            storedFile.mtimeMs = file.log.lastModifiedTime;
            storedFile.detected = file.log.detected;
          } catch (err) {
            sentResponse = true;
            reject(err);
          }
        })
        .on("end", () => {
          if (sentResponse) return;
          saveDirectoryStore();
          resolve();
        });
      function processBinned(fileToBin) {
        // bin the file if it isn't already (it shouldn't be)
        File.updateOne(
          { owner: uid, localPath: fileToBin, binned: false },
          {
            binned: true,
            $push: {
              "log.binnedHistory.list": {
                date: new Date(),
                ipAddress:
                  ip.address("public", "ipv6") || ip.address("public", "ipv4"),
                reason:
                  "local spider process detected this file (or its folder) no longer exists in user's file-system"
              }
            },
            $inc: {
              "log.binnedHistory.count": 1
            }
          },
          err => console.error("Couldn't bin a file\n", err)
        );
      }
    });
  });
}

function checkOptions(obj, required) {
  for (let i in required) {
    if (typeof obj[required[i]] === "undefined") {
      throw new Error("Missing option " + required[i]);
    }
  }
}

function saveDirectoryStore(onlyIfNew) {
  // only save directories if it doesn't already exist
  if (onlyIfNew && !!directoryStore) return;
  if (onlyIfNew && fs.existsSync(resolveDir("data/directories.json"))) return;
  let toSave = directoryStore || {
    uid,
    planId,
    active: [],
    ignore: []
  };
  fs.writeFileSync(resolveDir("data/directories.json"), JSON.stringify(toSave));
  if (onlyIfNew) {
    return (directoryStore = toSave);
  }
}

function readDirectoryStore() {
  directoryStore = JSON.parse(
    fs.readFileSync(resolveDir("data/directories.json"))
  );
}

function resetDirectoryStore() {
  directoryStore = null;
  fs.unlinkSync(resolveDir("data/directories.json"));
  return saveDirectoryStore(true);
}

module.exports = init;
