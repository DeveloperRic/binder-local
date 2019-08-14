const { BrowserWindow, app } = require("electron");

var appUtils = require("./appUtils");
var User = require("../../model/user");
var Block = require("../../model/block");
var Tier = require("../../model/tier");
var File = require("../../model/file");
var Download = require("../../model/download");
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

function sendMessage(channel, arg) {
  if (win) {
    win.webContents.send(channel, arg);
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
    Block: {
      find: (query, projection, callback) => {
        return Block.find(query, projection, callback);
      },
      aggregate: (aggregations, callback) => {
        return Block.aggregate(aggregations, callback);
      }
    },
    Tier: {
      findOne: (query, projection, callback) => {
        return Tier.findOne(query, projection, callback);
      }
    },
    File: {
      find: (query, projection, callback) => {
        return File.find(query, projection, callback);
      },
      aggregate: (aggregations, callback) => {
        return File.aggregate(aggregations, callback);
      }
    },
    Download: {
      findOne: (query, projection, callback) => {
        return Download.findOne(query, projection, callback);
      },
      aggregate: (aggregations, callback) => {
        return Download.aggregate(aggregations, callback);
      }
    }
  }
};
