// stats ctrl
app.controller("statsCtrl", function($scope, $rootScope, $interval) {
  const pathParse = require("path-parse");
  const speedTest = require("speedtest-net");
  const G = $rootScope.G;
  const { normalisePath } = G.require("services/coordination");
  const File = G.clientModels.File;

  // ---------------------------------------

  $scope.fixPathSlashes = normalisePath;
  $scope.smallerPath = smallerPath;

  var stage = ($scope.stage = {
    status: "waiting"
  });

  var filter = ($scope.filter = {
    filterStack: [],
    exists: () => !!filter.filterStack[0],
    folder: () => {
      if (!filter.filterStack[0]) return;
      return filter.filterStack[0];
    },
    clear: () => {
      filter.filterStack = [];
      filter.apply();
    },
    set: (folder, skipApply) => {
      filter.filterStack.unshift(folder);
      if (!skipApply) filter.apply();
    },
    back: () => {
      filter.filterStack.shift();
      filter.apply();
    },
    apply: () => {
      Promise.all([speeds.load(), actives.load()])
        .then(() => $scope.$apply())
        .catch(err => G.notifyError(err[0], err[1]));
    }
  });

  var speeds = ($scope.speeds = {
    internetUp: "n/a",
    internetDown: "n/a",
    archive: "n/a",
    changes: "n/a",
    test: {
      obj: null,
      success: false,
      msg: "",
      task: null
    },
    load: () => {
      return new Promise((resolve, reject) => {
        let query = {
          owner: G.user._id,
          // select files updated within the last 30 days
          "upload.finished": { $gte: Date.now() - 25920000000 }
        };
        if (filter.exists()) {
          query.localPath = {
            $regex: `/^${"G.regexEscape(filter.folder().actualPath)"}/`
          };
        }
        console.log(query);
        File.find(
          query,
          { upload: 1, latestSize: 1, versions: 1, "log.detected": 1 },
          (err, files) => {
            if (err) return reject(["Couldn't load archive speeds", err]);
            let archiveSize = 0,
              archiveTime = 0;
            let changeCount = 0;
            let minDetected;
            let now = Date.now();
            files.forEach(file => {
              if (file.upload.started && file.upload.finished) {
                let time = file.upload.finished - file.upload.started;
                if (file.upload.paused) {
                  time =
                    file.upload.finished -
                    file.upload.paused +
                    (file.upload.paused - file.upload.started);
                }
                archiveSize += file.latestSize;
                archiveTime += time;
              }
              changeCount += file.versions.count;
              if (!minDetected || file.log.detected < minDetected) {
                minDetected = file.log.detected;
              }
            });
            archiveTime = archiveTime / 3600000;
            let archiveSpeed =
              archiveTime == 0
                ? 0
                : archiveSize / (archiveTime >= 1 ? archiveTime : 1);
            console.log(archiveSize, archiveTime, archiveSpeed);
            let changeTime = minDetected
              ? (now - minDetected) / (3600000 * 24)
              : 0;
            console.log(changeCount, changeTime);
            if (archiveSpeed >= 1073741824) {
              speeds.archive = `~ ${Math.round(
                archiveSpeed / 1073741824
              )} Gb / hour`;
            } else if (archiveSpeed >= 1048576) {
              speeds.archive = `~ ${Math.round(
                archiveSpeed / 1048576
              )} Mb / hour`;
            } else if (archiveSpeed >= 1024) {
              speeds.archive = `~ ${Math.round(archiveSpeed / 1024)} Kb / hour`;
            } else {
              // lol #slowAF :)
              speeds.archive = `~ ${Math.round(archiveSpeed)} bytes / hour`;
            }
            let changeRatio =
              changeTime == 0
                ? 0
                : (changeCount / (changeTime >= 1 ? changeTime : 1)).toFixed(1);
            speeds.changes = `~ ${changeRatio} changes / day`;
            resolve();
          }
        ).sort({ "log.detected": -1 });
      });
    },
    checkInternet: () => {
      if (!speeds.test.obj) {
        speeds.test.obj = speedTest({ maxTime: 5000 });
        speeds.test.obj.on("data", data => {
          speeds.internetUp = `${data.speeds.upload.toFixed(2)} Mb/s`;
          speeds.internetDown = `${data.speeds.download.toFixed(2)} Mb/s`;
          $interval.cancel(speeds.test.task);
          speeds.test.obj = null;
          speeds.test.success = true;
          console.log(speeds.internetUp, speeds.internetDown);
          $scope.$apply();
        });
        speeds.test.obj.on("error", err => {
          $interval.cancel(speeds.test.task);
          speeds.test.obj = null;
          speeds.test.success = false;
          console.error(err);
          $scope.$apply();
        });
        speeds.test.msg = "testing";
        speeds.test.task = $interval(
          () => {
            if (speeds.test.msg.endsWith("...")) {
              speeds.test.msg = "testing";
            } else speeds.test.msg += ".";
          },
          400,
          50
        );
      }
    }
  });

  var actives = ($scope.actives = {
    folders: [],
    files: [],
    load: () => {
      return new Promise((resolve, reject) => {
        let query = {
          owner: G.user._id,
          // select files updated within the last 30 days
          "upload.finished": { $gte: Date.now() - 25920000000 }
        };
        if (filter.exists()) {
          query.localPath = {
            $regex: `/^${G.regexEscape(filter.folder().actualPath)}/`
          };
        }
        console.log(query);
        File.find(
          query,
          { localPath: 1, "versions.count": 1 },
          (err, files) => {
            if (err) return reject(["Couldn't load active files/folders", err]);
            files = files.map(file => {
              return {
                path: file.localPath,
                versionCount: file.versions.count
              };
            });
            actives.folders.length = 0;
            actives.files.length = 0;
            files.forEach(item => {
              let dir = pathParse(item.path).dir;
              let folder = actives.folders.find(f => f.actualPath == dir);
              if (!folder) {
                actives.folders.push({
                  actualPath: dir,
                  path: smallerPath(normalisePath(dir), 30),
                  versionCount: item.versionCount
                });
              } else {
                folder.versionCount += item.versionCount;
              }
              actives.files.push({
                actualPath: item.path,
                path: smallerPath(normalisePath(item.path), 30),
                versionCount: item.versionCount
              });
            });
            actives.folders = actives.folders.sort(
              (a, b) => b.versionCount - a.versionCount
            );
            actives.files = actives.files.sort(
              (a, b) => b.versionCount - a.versionCount
            );
            actives.folders.splice(5);
            actives.files.splice(5);
            resolve();
          }
        ).sort({ "log.detected": -1 });
      });
    }
  });

  // ---------------------------------------

  stage.status = "loading";

  G.getUser((err, user) => {
    if (err || !user) {
      stage.status = "error";
      return G.notifyError("We couldn't get your user info", err);
    }
    G.user = user;
    if (!user.plan) {
      stage.status = "error";
      G.notifyError("Cannot show info without a plan");
      return $scope.$apply();
    }
    Promise.all([applyFilterFromRedirect(), speeds.load(), actives.load()])
      .then(() => $scope.$apply(() => (stage.status = "")))
      .catch(args =>
        $scope.$apply(() => {
          stage.status = "error";
          G.notifyError(args[0] || "Unknown error", args[1] || args);
        })
      );
    speeds.checkInternet();
    $scope.$apply();
  });

  function applyFilterFromRedirect() {
    return new Promise(resolve => {
      if (G.stageStack.switchArgs.stats) {
        let path = G.stageStack.switchArgs.stats[0];
        if (path) {
          filter.set(
            { actualPath: path, path: smallerPath(normalisePath(path), 30) },
            true
          );
        }
      }
      resolve();
    });
  }

  function smallerPath(path, estLength) {
    let orgLength = path.length;
    path = path.substr(path.length - estLength, estLength);
    if (path.includes("/")) {
      path = path.substr(path.indexOf("/"));
    } else if (orgLength > estLength) {
      path = "…" + path;
    }
    return path;
  }
});
