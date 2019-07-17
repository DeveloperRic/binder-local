const { app, Tray, Menu, MenuItem, ipcMain } = require("electron");

const { createAuthWindow } = require("./frontend/app/auth-process");
const {
  createAppWindow,
  appWindowVisible,
  showAppWindow,
  hideAppWindow,
  sendMessage
} = require("./frontend/app/app-process");
const authService = require("./services/auth-service");
const uploadService = require("./services/upload-service");
const spiderService = require("./services/spider-service");

const setupPug = require("electron-pug");
const mongoose = require("mongoose");

var User = require("./model/user");
let initialised = false;

require("dotenv").config();

// TODO fix problems listed in VSCode problems tab (ctrl+`)

function showWindow(onAuthenticated) {
  authService
    .refreshTokens()
    .then(() => onAuthenticated())
    .catch(() => {
      createAuthWindow(onAuthenticated);
    });
}

let tray;

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  mongoose
    .connect(
      "mongodb+srv://client:dDbUSRI4hPWoPFzH@binder-hkqjh.gcp.mongodb.net/test?retryWrites=true&w=majority",
      {
        useNewUrlParser: true,
        useCreateIndex: true
      }
    )
    .then(() => console.log("Connected to MongoDB database"))
    .catch(err => console.error("Failed to connect to database", err));
  mongoose.set("useFindAndModify", false);

  setupPug({ pretty: true }, {})
    .then(pug => {
      pug.on("error", err => {}); // console.error("electron-pug error", err)
      declareTrayIcon();
      showWindow(() => {
        return new Promise((resolve, reject) => {
          declareIpcChannels();
          getUser((user, err1) => {
            startServices(user, err2 => {
              if (!err1 && !err2) {
                console.log("=[ Binder has started ]=");
              } else {
                //TODO somehow notify the user of these
                if (err1) console.error(err1);
                if (err2) console.error(err2);
                console.log("![ Some errors occured ]!");
              }
              if (!showAppWindow()) {
                createFrontend();
              }
              initialised = true;
              resolve();
            });
          });
        });
      });
    })
    .catch(err => console.error("Could not initiate 'electron-pug'", err));
});

// Quit when all windows are closed.
// app.on("window-all-closed", () => {
//   app.quit();
// });
app.on("before-quit", () => {
  app.isQuiting = true;
});

function onTrayClick() {
  if (!initialised) return;
  if (appWindowVisible()) {
    hideAppWindow();
  } else if (!showAppWindow()) {
    createFrontend();
  }
}

function createFrontend() {
  createAppWindow(
    () => {
      tray = null;
    },
    callback => {
      app.relaunch();
      quit();
    }
  );
}

function quit() {
  app.isQuiting = true;
  app.quit();
}

function declareTrayIcon() {
  tray = new Tray(`${__dirname}/frontend/img/tray-icon.png`); //32x32
  tray.on("click", onTrayClick);
  tray.setToolTip("Binder is running");
  tray.setHighlightMode("always");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open", click: onTrayClick },
      { label: "Quit", click: quit }
    ])
  );
  console.log("Declared tray icon");
}

function declareIpcChannels() {
  ipcMain.on("upload-service", (event, arg) => {
    event.returnValue = uploadService;
  });
  ipcMain.on("spider-select-folder", (event, arg) => {
    if (typeof arg.path === "undefined" || typeof arg.include === "undefined") {
      throw new Error("arg must include 'path' and 'include'");
    }
    spiderService.selectDirectory(arg.path, arg.include);
    event.returnValue = true;
  });
  ipcMain.on("spider-select-file", (event, arg) => {
    if (typeof arg.path === "undefined" || typeof arg.include === "undefined") {
      throw new Error("arg must include 'path' and 'include'");
    }
    spiderService.selectFile(arg.path, arg.include);
    event.returnValue = true;
  });
  ipcMain.on("spider-directoryStore", (event, arg) => {
    event.returnValue = spiderService.readOnlyDirectoryStore();
  });
  ipcMain.on("upload-event-handlers", (event, arg) => {
    uploadService.setUploadHandlers(arg);
  });
  ipcMain.on("upload-status", (event, arg) => {
    sendMessage("upload-resume", uploadService.currentSchedule());
    event.returnValue = uploadService.currentSchedule();
  });
  uploadService.setUploadHandlers({
    resume: schedule => {
      console.log("==== emitting resume ====");
      sendMessage("upload-resume", schedule);
    },
    progress: (fileDat, partNumber) => {
      sendMessage("upload-progress", fileDat, partNumber);
    },
    success: fileDat => {
      console.log("==== emitting success ====");
      sendMessage("upload-success", fileDat);
    },
    failed: fileDat => {
      console.log("==== emitting failed ====");
      sendMessage("upload-failed", fileDat);
    },
    allUploaded: schedule => {
      console.log("==== emitting all-done ====");
      sendMessage("upload-all-uploaded", schedule);
    },
    allFailed: schedule => {
      console.log("==== emitting all-failed ====");
      sendMessage("upload-all-failed", schedule);
    }
  });
  console.log("Declared ipc channels");
}

function getUser(next) {
  let profile = authService.getProfile();
  User.findOneAndUpdate(
    { email: profile.email },
    {
      email_verified: profile.email_verified,
      profile: {
        nickname: profile.nickname,
        picture: profile.picture
      }
    },
    {
      upsert: true,
      setDefaultsOnInsert: true,
      new: true,
      projection: { _id: 1, "plan.expired": 1, "plan.blocks": 1 }
    },
    (err, user) => {
      if (err) return next(null, err);
      if (!user) {
        return next(
          null,
          new Error(
            `user with email ${authService.getProfile().email} not found!`
          )
        );
      }
      console.log("Got user");
      next(user);
    }
  ).lean(true);
}

function startServices({ _id: uid, plan }, next) {
  if (plan && plan.expired) {
    console.log("User's plan has expired, upload+spider services not started");
    return next();
  }
  uploadService
    .init(uid)
    .then(() => {
      console.log("Upload service started & resuming..");
      uploadService
        .pause()
        .then(uploadService.resume)
        .catch("Upload service blocked the resume. Possible plan expiry");
      spiderService
        .startSpider(uid, uploadService)
        .then(() => {
          console.log("Spider started successfully");
          next();
        })
        .catch(err => {
          return next(err);
        });
    })
    // nothing is allowed to go wrong here!
    .catch(err => {
      return next(err);
    });
}
