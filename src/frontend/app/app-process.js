const { BrowserWindow, app } = require("electron");

const appUtils = require("./appUtils");
const User = require("../../model/user");
const Plan = require("../../model/plan");
const Block = require("../../model/block");
const Tier = require("../../model/tier");
const File = require("../../model/file");
const Download = require("../../model/download");

let win;
let relaunchFunction;

function createAppWindow(onClose, relaunchFunc) {
  win = new BrowserWindow({
    width: 1000,
    height: 600,
    webPreferences: {
      nodeIntegration: true
    },
    autoHideMenuBar: true
  });

  appUtils.loadView(win, "home");
  relaunchFunction = relaunchFunc;

  win.on("minimize", event => {
    event.preventDefault();
    win.hide();
  });
  win.on("close", event => {
    if (!app.isQuiting) {
      event.preventDefault();
      win.hide();
    } else {
      win = null;
      onClose();
    }
  });
}

function showAppWindow() {
  if (win) {
    win.show();
    return true;
  }
  return false;
}

function hideAppWindow() {
  if (win) {
    win.hide();
    return true;
  }
  return false;
}

function sendMessage(channel, ...args) {
  if (win) {
    win.webContents.send(channel, ...args);
    return true;
  }
  return false;
}

module.exports = {
  createAppWindow,
  appWindowVisible: () => !!win && win.isVisible(),
  showAppWindow,
  hideAppWindow,
  sendMessage,
  getViewComponentUrl: appUtils.getViewComponentUrl,
  relaunch: () => relaunchFunction(),
  clientModels: {
    User: {
      findOne: (query, projection, callback) => {
        return User.findOne(query, projection, callback);
      },
      updateOne: (query, doc, cb) => {
        return User.updateOne(query, doc, cb);
      }
    },
    Plan: {
      findById: (id, projection, callback) => {
        return Plan.findById(id, projection, callback);
      },
      findOne: (query, projection, callback) => {
        return Plan.findOne(query, projection, callback);
      },
      updateOne: (query, doc, cb) => {
        return Plan.updateOne(query, doc, cb);
      }
    },
    Block: {
      find: (query, projection, callback) => {
        return Block.find(query, projection, callback);
      },
      aggregate: (aggregations, callback) => {
        return Block.aggregate(aggregations, callback);
      }
    },
    Tier: {
      findById: (id, projection, callback) => {
        return Tier.findById(id, projection, callback);
      }
    },
    File: {
      find: (query, projection, callback) => {
        return File.find(query, projection, callback);
      },
      aggregate: (aggregations, callback) => {
        return File.aggregate(aggregations, callback);
      },
      updateOne: (query, doc, cb) => {
        return File.updateOne(query, doc, cb);
      },
      updateMany: (query, doc, cb) => {
        return File.updateMany(query, doc, cb);
      }
    },
    Download: {
      find: (query, projection, callback) => {
        return Download.find(query, projection, callback);
      },
      findOne: (query, projection, callback) => {
        return Download.findOne(query, projection, callback);
      },
      aggregate: (aggregations, callback) => {
        return Download.aggregate(aggregations, callback);
      }
    }
  }
};
