const fs = require("fs");
const pathParse = require("path-parse");
const { resolveDir } = require("../prodVariables");

const LOCAL_SETTINGS_PATH = "data/localSettings.json";
const DEFAULT_SETTINGS = { autolaunch: { enabled: true } };

let settings;

/**
 * Loads up settings, or writes the default if none exist
 * @returns {Promise<DEFAULT_SETTINGS>}
 */
function load() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(resolveDir(LOCAL_SETTINGS_PATH))) {
      fs.readFile(resolveDir(LOCAL_SETTINGS_PATH), (err, data) => {
        if (err) return reject(err);
        resolve((settings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) }));
      });
    } else {
      save(DEFAULT_SETTINGS)
        .then(resolve)
        .catch(reject);
    }
  });
}

function get() {
  return settings;
}

function set(update, ...path) {
  let previousParent = null;
  let parent = settings;
  let previous;
  let next;
  while (parent != null && (next = path.shift())) {
    previous = next;
    previousParent = parent;
    parent = parent[next];
  }
  if (!!previousParent) {
    previousParent[previous] = update;
    return true;
  } else return false;
}

/**
 * Saves settings to the disk and updates it in memory
 * @param {DEFAULT_SETTINGS} s
 * @returns {Promise<DEFAULT_SETTINGS>}
 */
function save(s = settings) {
  return new Promise((resolve, reject) => {
    let realPath = resolveDir(LOCAL_SETTINGS_PATH);
    fs.mkdir(pathParse(realPath).dir, { recursive: true }, err => {
      if (err) return reject(err);
      fs.writeFile(realPath, JSON.stringify(s), err => {
        if (err) return reject(err);
        resolve((settings = s));
      });
    });
  });
}

module.exports = {
  LOCAL_SETTINGS_PATH,
  load,
  get,
  set,
  save
};
