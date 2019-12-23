const fs = require("fs");
const Spider = require("./spider");

let spider;

/**
 * Starts the Spider
 * @param {"ObjectId"} uid
 * @param {"ObjectId"} planId
 */
function startSpider(uid, planId, uploadService) {
  return new Promise((resolve, reject) => {
    let start = () => {
      spider
        .startTask()
        .then(resolve)
        .catch(reject);
    };
    if (spider) {
      if (spider.isRunning()) return resolve();
      else {
        start();
      }
    } else {
      Spider({
        uid,
        planId,
        firstDelay: 60 * 1000, // wait 1 min first
        taskDelay: 5 * 60 * 1000, // every 5 mins
        uploadService
      })
        .then(s => {
          spider = s;
          start();
        })
        .catch(reject);
    }
  });
}

function readOnlyDirectoryStore() {
  return new Promise((resolve, reject) => {
    if (!spider) return reject(new Error("spider is undefined"));
    let store = spider.readOnlyDirectoryStore();
    if (store) {
      return resolve(store);
    } else {
      spider
        .pullDirectoryStore()
        .then(() => {
          resolve(spider.readOnlyDirectoryStore());
        })
        .catch(reject);
    }
  });
}

function directoryIsSelected(path) {
  return spider.directoryIsSelected(path);
}

function fileIsSelected(path) {
  return spider.fileIsSelected(path);
}

function selectDirectory(path, include) {
  let startAtEnd = false;
  if (spider.isRunning()) {
    spider.cancelTask();
    spider.wasCancelled = true;
    startAtEnd = true;
  }
  spider.selectDirectory(path, include, true);
  let searchDirectory = path => {
    let entries = fs.readdirSync(path, { withFileTypes: true });
    const slash = path.includes("\\") ? "\\" : "/";
    entries.forEach(ent => {
      if (ent.isDirectory()) {
        let dirPath = `${path}${slash}${ent.name}`;
        spider.selectDirectory(dirPath, include, true);
        searchDirectory(dirPath);
      }
    });
  };
  searchDirectory(path);
  spider.saveDirectoryStore();
  if (startAtEnd) {
    spider.startTask(true);
  }
}

function selectFile(path, include) {
  let startAtEnd = false;
  if (spider.isRunning()) {
    spider.cancelTask();
    spider.wasCancelled = true;
    startAtEnd = true;
  }
  let p = spider.selectFile(path, include);
  if (startAtEnd) {
    spider.startTask(true);
  }
  return p;
}

module.exports = {
  startSpider,
  readOnlyDirectoryStore,
  directoryIsSelected,
  fileIsSelected,
  selectDirectory,
  selectFile
};
