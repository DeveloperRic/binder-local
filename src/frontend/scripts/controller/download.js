// download ctrl
app.controller("downloadCtrl", function($scope, $rootScope, $http, $interval) {
  const fs = require("fs");
  const G = $rootScope.G;
  var Block = G.clientModels.Block;
  var File = G.clientModels.File;
  var Download = G.clientModels.Download;

  // ---------------------------------------

  var stage = ($scope.stage = {
    status: "waiting",
    checkArgs: () => {
      return new Promise((resolve, reject) => {
        if (G.stageStack.switchArgs.download) {
          actions
            .downloadFiles(
              G.stageStack.switchArgs.download[0],
              G.stageStack.switchArgs.download[1]
            )
            .then(resolve)
            .catch(reject);
        } else {
          resolve();
        }
      });
    }
  });

  var actions = ($scope.actions = {
    downloadFiles: (passedFiles, returnArgs) => {
      return new Promise((resolve, reject) => {
        if (!passedFiles) {
          G.switchStage("folders", "browse");
          resolve();
        } else {
          let p = actions.submitDownloadRequest(passedFiles);
          p.then(resolve);
          p.catch(() => {
            G.switchStage("folders", ...returnArgs);
          }).then(reject);
        }
      });
    },
    downloadBlock: () => {
      G.loadingPopup.visible = true;
      Block.find(
        { _id: { $in: G.user.plan.blocks } },
        { latestSize: 1 },
        (err, blocks) => {
          if (err) {
            G.loadingPopup.visible = false;
            return G.notifyError("Couldn't get your blocks", err);
          }
          G.notifyChoose(
            "custom",
            {
              name: "Pick a block to download",
              children: blocks.map((block, i) => {
                let size = block.latestSize;
                if (size >= 1073741824) {
                  size = `${(size / 1073741824).toFixed(1)} Gb`;
                } else if (size >= 1048576) {
                  size = `${(size / 1048576).toFixed(1)} Mb`;
                } else if (size >= 1024) {
                  size = `${(size / 1024).toFixed(1)} Kb`;
                } else {
                  size = "< 1 Kb";
                }
                return {
                  id: block._id,
                  name: `Block ${i + 1} [ ${size} ]`
                };
              })
            },
            block => {
              if (!block) {
                return (G.loadingPopup.visible = false);
              }
              block = block.id;
              File.find(
                { owner: G.user._id, block },
                { _id: 1 },
                (err, files) => {
                  if (err) {
                    return G.notifyError(
                      "Couldn't submit downlaod request",
                      err
                    );
                  }
                  actions
                    .submitDownloadRequest(files.map(f => f._id))
                    .catch(() => {
                      $scope.$apply(() => (G.loadingPopup.visible = false));
                    });
                }
              ).lean(true);
            }
          );
          $scope.$apply();
        }
      );
    },
    downloadBinder: () => {
      G.loadingPopup.visible = true;
      File.find({ owner: G.user._id }, { _id: 1 }, (err, files) => {
        if (err) {
          G.loadingPopup.visible = false;
          return G.notifyError("Couldn't submit download request", err);
        }
        actions.submitDownloadRequest(files.map(f => f._id)).catch(() => {
          $scope.$apply(() => (G.loadingPopup.visible = false));
        });
      }).lean(true);
    },
    submitDownloadRequest: filesToDownload => {
      return new Promise((resolve, reject) => {
        if (
          !confirm(
            "Are you sure you want to download these files?\n" +
              "Please note that once a download request is sent, " +
              "it MUST be completed before a new one can be requested."
          )
        ) {
          return reject();
        }
        G.loadingPopup.visible = true;
        setImmediate(() => {
          alert(
            "Next, you will select a folder to download files to.\n" +
              "Binder will securely download your files to a private location first, before moving it to your selected folder."
          );
          let releasePath = G.remote.dialog.showOpenDialog(
            G.remote.getCurrentWindow(),
            {
              title: "Select download location",
              buttonLabel: "Choose folder",
              properties: ["openDirectory"]
            }
          );
          if (!releasePath) {
            G.notifyError("You must select a folder to put downloads in");
            return $scope.$apply(() => reject());
          }
          releasePath = releasePath[0];
          try {
            if (fs.readdirSync(releasePath).length > 0) {
              G.notifyError("Please select an empty folder");
              return $scope.$apply(() => reject());
            }
          } catch (err) {
            G.notifyError("Something went wrong, please try again", err);
            return $scope.$apply(() => reject());
          }
          requestDownloadResponse.timeoutTask = $interval(
            () => {
              if (!requestDownloadResponse.allow) return;
              G.loadingPopup.visible = requestDownloadResponse.allow = false;
              G.notifyError(
                "The download service took too long to respond. Please try again"
              );
              reject();
            },
            10000 * Math.max(1, (filesToDownload.length / 100).toFixed(0)),
            1
          );
          requestDownloadResponse.allow = true;
          filesToDownload = filesToDownload.map(f => f.toString());
          G.ipcRenderer.send("download-request", filesToDownload, releasePath);
        });
      });
    }
  });

  let requestDownloadResponse = {
    allow: false
  };
  G.ipcRenderer.on("download-request-err", err => {
    if (!requestDownloadResponse.allow) return;
    G.loadingPopup.visible = requestDownloadResponse.allow = false;
    $interval.cancel(requestDownloadResponse.timeoutTask);
    G.notifyError("Something went wrong, please try again", err);
    $scope.$apply(() => requestDownloadResponse.reject());
  });
  G.ipcRenderer.on("download-request-res", downloadId => {
    if (!requestDownloadResponse.allow) return;
    G.loadingPopup.visible = requestDownloadResponse.allow = false;
    $interval.cancel(requestDownloadResponse.timeoutTask);
    status.downloadId = downloadId;
    status.refresh();
    $scope.$apply(() => requestDownloadResponse.resolve());
  });

  var status = ($scope.status = {
    downloadId: null,
    progress: null,
    downloadProjection: {
      finishBy: 1,
      "log.taskStartDate": 1,
      "log.packagedDate": 1,
      "log.downloadFinishDate": 1,
      "log.completedDate": 1
    },
    autoRefreshTimes: 0,
    refreshTask: null,
    refresh: isAuto => {
      return new Promise((resolve, reject) => {
        if (isAuto) {
          status.autoRefreshTimes++;
        } else {
          status.autoRefreshTimes = 0;
        }
        let query;
        if (status.downloadId) {
          query = { _id: status.downloadId };
        } else {
          query = { user: G.user._id, active: true };
        }
        Download.findOne(query, status.downloadProjection, (err, download) => {
          if (err) return reject(["Couldn't update download status", err]);
          if (download) {
            status.parseDownload(download);
          } else if (status.downloadId) {
            status.downloadId = null;
            return reject(["Couldn't find a download with that id"]);
          }
          status.downloadId = null;
          resolve();
        });
      });
    },
    parseDownload: download => {
      console.log(JSON.stringify(download));
      status.progress = {
        // by this I mean the process has started
        started:
          download.log.taskStartDate &&
          Date.now() >= download.log.taskStartDate,
        packaged: Boolean(download.log.packagedDate),
        downloaded: Boolean(download.log.downloadFinishDate),
        isReady: Boolean(download.log.completedDate)
      };
      $interval.cancel(status.refreshTask);
      if (!status.progress.isReady) {
        let deadline = new Date(download.finishBy.date);
        let deadlineTime = G.dateToTime(deadline);
        let deadlineDiff =
          Math.abs(deadline.getTime() - new Date().getTime()) / 86400000;
        if (deadlineDiff == 0) {
          status.progress.finishBy = `Today ${deadlineTime.hours}:${
            deadlineTime.minutes
          }`;
        } else if (deadlineDiff == 1) {
          status.progress.finishBy = `Tomorrow ${deadlineTime.hours}:${
            deadlineTime.minutes
          }`;
        } else {
          status.progress.finishBy = `${G.daysOfWeek[deadline.getDay()]} ${
            deadlineTime.hours
          }:${deadlineTime.minutes}`;
        }
        if (status.progress.started) {
          let step;
          if (status.progress.packaged) {
            if (status.progress.downloaded) {
              step = "decrypt";
            } else {
              step = "download";
            }
          } else {
            step = "package";
          }
          status.progress.current = {
            step,
            left: true,
            right: false
          };
          let left = 85;
          status.refreshTask = $interval(
            () => {
              left--;
              status.progress.current.left = !status.progress.current.left;
              status.progress.current.right = !status.progress.current.right;
              if (left <= 1 && status.autoRefreshTimes < 9) {
                status
                  .refresh(true)
                  .then(() => $scope.$apply())
                  .catch(err =>
                    $scope.$apply(
                      G.notifyError("Couldn't refresh download status", err)
                    )
                  );
              }
            },
            700,
            85
          );
          console.log(status.progress);
        }
      } else {
        status.showDownload = () => {
          //TODO show files
          G.notifyError(download.log.completedDate);
        };
      }
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
    console.log(JSON.parse(JSON.stringify(user)));
    if (!user.plan) {
      stage.status = "error";
      G.notifyError("Cannot show info without a plan");
      return $scope.$apply();
    }
    Promise.all([stage.checkArgs(), status.refresh()])
      .then(() => $scope.$apply(() => (stage.status = "")))
      .catch(err => {
        if (err[0]) {
          G.notifyError(err[0], err[1]);
        } else {
          G.notifyError("Something went wrong", err);
        }
        $scope.$apply(() => (stage.status = "error"));
      });
    $scope.$apply();
  }, "plan.blocks");
});
