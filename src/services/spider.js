const fs = require("fs");
const pathParse = require("path-parse");
const ip = require("ip");

var uploadService;
var File = require("../model/file");

let uid;
var directoryStore;
let taskDelay;
let process;
let processing = false;
let wasCancelled = false;
let initialised = false;

/**
 * Initialises the spider
 * @param {{uid: "ObjectId", taskDelay: Number}} options
 * @throws an error if already initialised
 */
function init(options) {
  return new Promise((resolve, reject) => {
    if (initialised) {
      return reject(new Error("Spider already initialised"));
    }
    setImmediate(() => {
      checkOptions(options, ["uid", "taskDelay", "uploadService"]);
      uid = options.uid;
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
        finialiseInit();
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
          selectDirectory,
          selectFile,
          saveDirectoryStore
        });
      }
    });
  });
}

function startTask() {
  checkOptions({ uid }, ["uid"]);
  return new Promise((resolve, reject) => {
    // clear running process
    // NOTE: upload processes may still be running!
    if (process) clearInterval(process);
    // check upload-service is initialised
    if (!uploadService.initialised()) {
      return reject("upload-service not initialised");
    } else {
      // start spider process
      process = setInterval(task, taskDelay);
      resolve();
    }
  });
}

function cancelTask() {
  if (!process) {
    process = clearInterval(process);
  }
  // prevent spawning of a new process
  // (this is more of a fail-safe)
  wasCancelled = false;
}

function selectDirectory(path, include, doNotSave) {
  checkOptions({ path, include }, ["path", "include"]);
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
    // remove the match
    directoryStore.active.splice(directoryIndex, 1);
  }
  if (!doNotSave) saveDirectoryStore();
}

function selectFile(path, include) {
  checkOptions({ path, include }, ["path", "include"]);
  if (!fs.existsSync(path) && include) {
    throw new Error("path doesn't exist");
  }
  // load the current directory store
  if (!directoryStore) readDirectoryStore();
  let directoryIndex = directoryStore.active.findIndex(
    d => d.path == pathParse(path).dir
  );
  if (include) {
    let file = {
      path: path,
      mtimeMs: fs.statSync(path).mtimeMs, // is corrected below
      ignore: false,
      detected: new Date().getTime()
    };
    // if you want to include and the corresponding folder
    // was not found, insert one (including the new file)
    if (directoryIndex < 0) {
      directoryStore.active.push({
        path: path,
        files: [file]
      });
    } else if (
      !directoryStore.active[directoryIndex].files.find(f => f.path == path)
    ) {
      // if the corresponding folder was found and a matching file
      // was not found, insert the new file
      directoryStore.active[directoryIndex].files.push(file);
    }
  } else if (directoryIndex >= 0) {
    // only continues if you want to ignore and the
    // corresponding folder was found
    let file = directoryStore.active[directoryIndex].files.find(
      f => f.path == path
    );
    if (file) {
      // if a matching file was found, ignore it
      file.ignore = true;
    }
  }
  saveDirectoryStore();
}

function task() {
  console.log("spider spawned");
  // don't resume process if one is already running
  if (processing) {
    cancelTask();
    // inform current process a new one is waiting
    wasCancelled = true;
    return;
  }
  // inform future processes we are busy
  processing = true;
  console.log(" - spider processing");
  let changed = [];
  let removed = [];
  let now = new Date();
  // ignore non-existant directories
  directoryStore.active = directoryStore.active.filter(directory => {
    if (!fs.existsSync(directory.path)) {
      // set an ignored date for future complete removal
      directory.ignoredOn = now.getTime();
      directoryStore.ignore.push(directory);
      return false;
    } else return true;
  });
  // re-activate ignored directories that re-appear within a week
  const WEEK_MILLS = 6048000000;
  directoryStore.ignore.filter(directory => {
    if (fs.existsSync(directory.path)) {
      // clear ignored date for the found directory
      delete directory.ignoredOn;
      directoryStore.active.push(directory);
      return false;
    } else if (now > directory.ignoredOn + WEEK_MILLS) {
      // completely remove directories that have been
      // removed for over a week
      // TODO notify user of this
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
      let slash = directory.path.includes("\\") ? "\\" : "/";
      const filePath = `${directory.path}${slash}${ent.name}`;
      let stat = fs.statSync(filePath);
      let storedDat = directory.files.find(v => v.path == filePath);
      // if no stored info on this file, push a new one
      if (!storedDat) {
        directory.files.push(
          (storedDat = {
            path: filePath,
            mtimeMs: 0, // is corrected below
            ignore: false,
            detected: new Date().getTime()
          })
        );
      }
      // skip if file is ignored
      // (absolutely won't skip if file's new)
      if (storedDat.ignore) continue;
      if (stat.mtimeMs > storedDat.mtimeMs) {
        // declare a changed file
        changed.push({
          directory: directory.path,
          path: filePath,
          modified: stat.mtimeMs,
          bytes: {
            total: stat.size,
            done: 0,
            failed: 0
          }
        });
      }
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
          let slash = directory.path.includes("\\") ? "\\" : "/";
          return `${directory.path}${slash}${ent.name}` == file.path;
        })
      ) {
        // declare a removed file
        removed.push({
          directory: directory.path,
          path: file.path,
          detected: new Date().getTime()
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
  console.log("spider > upload-service");
  uploadService
    .processChanges(changed, removed)
    .then(() => {
      console.log("spider > upload-service (done)");
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
      let filesToBin = [];
      File.find(
        { owner: uid },
        { localPath: 1, binned: 1, log: { detected: 1 } },
        (err, files) => {
          if (err) return reject(err);
          for (let i in files) {
            const file = files[i];
            const path = pathParse(file.localPath);
            // TODO notify user of files held in database
            // that no longer exist in fs
            if (!fs.existsSync(file.localPath)) {
              if (!file.binned) {
                // minimise internet usage by performing
                // bulk updates
                filesToBin.push(file.localPath);
              }
              continue;
            }
            // Typically, if a file exists, then its directory
            // exists. Sometimes this is not true, so we must check
            if (!fs.existsSync(path.dir)) continue;
            // only pull directories that aren't being ignored
            if (directoryStore.ignore.find(d => d.path == path.dir)) {
              continue;
            }
            let dir;
            // search for directory in store, pushing
            // a new entry if not found
            if (!(dir = directoryStore.active.find(d => d.path == path.dir))) {
              dir = {
                path: path.dir,
                files: []
              };
              directoryStore.active.push(dir);
            }
            let storedFile = dir.find(f => f.path == file.localPath);
            if (!storedFile) {
              storedFile = {
                path: file.localPath
              };
              // don't worry, js keeps (storedFile) referenced
              // in the (dir) object, so updates will persist
              dir.push(storedFile);
            }
            let fileStat = fs.statSync(storedFile.path);
            storedFile.mtimeMs = fileStat.mtimeMs;
            storedFile.ignore = file.binned;
            storedFile.detected = file.log.detected;
          }
          saveDirectoryStore();
          processBinned();
        }
      );
      function processBinned() {
        if (filesToBin.length > 0) {
          // select files that haven't been binned and bin them
          File.updateMany(
            { owner: uid, localPath: { $in: filesToBin }, binned: false },
            {
              binned: true,
              log: {
                $push: {
                  binnedHistory: {
                    date: new Date(),
                    ipAddress: ip.address("public", "ipv6"),
                    reason:
                      "pullUpdate() process detected this file no longer exists in user's file-system"
                  }
                }
              }
            },
            (err, _done) => {
              if (err) return reject(err);
              resolve();
            }
          );
        } else {
          resolve();
        }
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
  // only save directories if no schema exists
  if (onlyIfNew && !!directoryStore) return;
  if (onlyIfNew && fs.existsSync("src/data/directories.json")) return;
  let toSave = directoryStore || {
    active: [],
    ignore: []
  };
  fs.writeFileSync("src/data/directories.json", JSON.stringify(toSave));
  if (onlyIfNew) {
    return (directoryStore = toSave);
  }
}

function readDirectoryStore() {
  directoryStore = JSON.parse(fs.readFileSync("src/data/directories.json"));
}

module.exports = init;
