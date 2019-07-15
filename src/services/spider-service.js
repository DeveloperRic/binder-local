const fs = require("fs");
const Spider = require("./spider");

let spider;

/**
 * Starts the Spider
 * @param {"ObjectId"} uid
 */
function startSpider(uid, uploadService) {
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
        taskDelay: 60 * 1000,
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
  if (!spider) return null;
  return spider.readOnlyDirectoryStore();
}

function selectDirectory(path, include) {
  let startAtEnd = true;
  if (spider.isRunning()) {
    spider.cancelTask();
    spider.wasCancelled = true;
    startAtEnd = false;
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
    spider.startTask();
  }
}

function selectFile(path, include) {
  let startAtEnd = true;
  if (spider.isRunning()) {
    spider.cancelTask();
    spider.wasCancelled = true;
    startAtEnd = false;
  }
  spider.selectFile(path, include);
  if (startAtEnd) {
    spider.startTask();
  }
}

module.exports = {
  startSpider,
  readOnlyDirectoryStore,
  selectDirectory,
  selectFile
};
