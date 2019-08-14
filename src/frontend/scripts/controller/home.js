// home ctrl
app.controller("homeCtrl", function($scope, $rootScope, $http, $interval) {
  const Chart = require("chart.js");
  const G = $rootScope.G;
  const { normalisePath } = G.require("services/coordination");
  const Block = G.clientModels.Block;
  const Tier = G.clientModels.Tier;
  const User = G.clientModels.User;

  // ---------------------------------------

  var stage = ($scope.stage = {
    status: "waiting"
  });

  var uploads = ($scope.uploads = {
    status: "waiting",
    queue: [],
    overallPercent: 0,
    failed: [
      {
        filename: "/frontend/img",
        path:
          "C:\\Users\\Victor\\GitHub\\binderv4\\electron\\src\\frontend\\img",
        isNew: true,
        pendingRetry: true
      },
      {
        filename: "/Desktop/Clutter",
        path: "C:UsersVictorDesktopClutter",
        isNew: false
      },
      {
        filename: "/Desktop/saturday",
        path: "C:UsersVictorDesktopsaturday",
        isNew: true,
        pendingRetry: false
      },
      {
        filename: "/frontend/img",
        path:
          "C:\\Users\\Victor\\GitHub\\binderv4\\electron\\src\\frontend\\img",
        isNew: true,
        pendingRetry: true
      },
      {
        filename: "/Desktop/Clutter",
        path: "C:UsersVictorDesktopClutter",
        isNew: false
      },
      {
        filename: "/Desktop/saturday",
        path: "C:UsersVictorDesktopsaturday",
        isNew: true,
        pendingRetry: false
      }
    ],
    initialised: false,
    current: null,
    uploadChart: null,
    defineListeners: () => {
      if (uploads.initialised) return;
      G.ipcRenderer.removeAllListeners("upload-resume");
      G.ipcRenderer.on("upload-resume", (event, arg) => {
        console.log("==== got resume ====");
        uploads
          .refresh(arg)
          .catch(err => {
            handleError(err, "Couldn't update upload progress");
          })
          .then(() => $scope.$apply());
      });
      G.ipcRenderer.removeAllListeners("upload-seccess");
      G.ipcRenderer.on("upload-success", (event, arg) => {
        console.log("==== got success ====");
        if (uploads.status != "") return;
        let itemIndex = uploads.queue.findIndex(u => u.path == arg.path);
        if (itemIndex >= 0) {
          uploads.queue.splice(itemIndex, 1);
          uploads.updatePercentAndCurrent();
          $scope.$apply();
        }
      });
      G.ipcRenderer.removeAllListeners("upload-failed");
      G.ipcRenderer.on("upload-failed", (event, arg) => {
        console.log("==== got failed ====");
        if (uploads.status != "") return;
        let itemIndex = uploads.queue.findIndex(u => u.path == arg.path);
        if (itemIndex >= 0) {
          uploads.queue.splice(itemIndex, 1);
          uploads.failed.unshift(uploads.fileDatToQueueItem(arg));
          uploads.updatePercentAndCurrent();
          $scope.$apply();
        }
      });
      G.ipcRenderer.removeAllListeners("upload-all-uploaded");
      G.ipcRenderer.on("upload-all-uploaded", (event, args) => {
        console.log("==== got all-done ====");
        if (uploads.status != "") return;
        uploads.current = null;
        uploads.queue.length = 0;
      });
      G.ipcRenderer.removeAllListeners("upload-all-failed");
      G.ipcRenderer.on("upload-all-failed", (event, arg) => {
        console.log("==== got all-failed ====");
        if (uploads.status != "") return;
        uploads.queue.length = 0;
        arg.changed.forEach(item => {
          uploads.processItemUpdate(item);
        });
        uploads.queue
          .splice(0)
          .reverse()
          .forEach(item => {
            if (uploads.failed.findIndex(i => i.path == item.path) < 0) {
              uploads.failed.unshift(item);
            }
          });
        uploads.updatePercentAndCurrent();
        $scope.$apply();
      });
      uploads.initialised = true;
    },
    defineUploadChart: () => {
      uploads.uploadChart = new Chart(document.getElementById("circle-graph"), {
        type: "doughnut",
        data: {
          datasets: [
            {
              data: [0, 100],
              backgroundColor: ["#4caf50"]
            }
          ],
          labels: ["% Completed", "% Remaining"]
        },
        options: {
          cutoutPercentage: 70,
          legend: {
            display: false
          }
        }
      });
      // $interval(
      //   () => {
      //     uploads.uploadChart.data.datasets[0].data[0] += 10;
      //     uploads.uploadChart.data.datasets[0].data[1] -= 10;
      //     uploads.uploadChart.update();
      //   },
      //   500,
      //   10
      // );
    },
    refresh: schedule => {
      return new Promise((resolve, reject) => {
        uploads.status = "loading";
        setImmediate(() => {
          if (!schedule) schedule = G.ipcRenderer.sendSync("upload-status");
          if (schedule) {
            console.log(schedule);
            try {
              uploads.queue.length = 0;
              schedule.changed.forEach(item => {
                uploads.processItemUpdate(item);
              });
            } catch (err) {
              reject(["Failed to get upload status", err]);
              return (uploads.status = "error");
            }
          }
          uploads.updatePercentAndCurrent();
          uploads.status = "";
          resolve();
        });
      });
    },
    processItemUpdate: (fileDat, partNumber) => {
      let queueItem = uploads.fileDatToQueueItem(fileDat);
      let itemIndex = uploads.queue.findIndex(u => u.path == fileDat.path);
      if (itemIndex < 0) {
        uploads.queue.unshift(queueItem);
      } else {
        uploads.queue[itemIndex] = queueItem;
        if (itemIndex > 0) {
          uploads.queue.unshift(uploads.queue.splice(itemIndex, 1)[0]);
        }
      }
    },
    fileDatToQueueItem: fileDat => {
      let size = fileDat.bytes.total;
      if (size >= 1073741824) {
        size = `${(size / 1073741824).toFixed(1)} Gb`;
      } else if (size >= 1048576) {
        size = `${(size / 1048576).toFixed(1)} Mb`;
      } else {
        size = `${(size / 1024).toFixed(1)} Kb`;
      }
      return {
        path: fileDat.path,
        filename: smallerPath(normalisePath(fileDat.path), 15),
        isNew: fileDat.isNew,
        version: fileDat.version,
        bytes: fileDat.bytes,
        parts: fileDat.parts,
        size: size
      };
    },
    updatePercentAndCurrent: () => {
      console.log(uploads.queue);
      try {
        if (uploads.queue.length > 0) {
          uploads.overallPercent = Math.round(
            (uploads.queue.reduce(
              (acc, cur) => (acc += (cur.bytes.done * 100) / cur.bytes.total),
              0
            ) *
              100) /
              (uploads.queue.length * 100)
          );
        } else {
          uploads.overallPercent = 0;
        }
        uploads.current = uploads.queue[0];
        if (uploads.uploadChart) {
          if (uploads.current) {
            uploads.uploadChart.data.datasets[0].data[1] =
              uploads.current.bytes.total -
              (uploads.uploadChart.data.datasets[0].data[0] =
                uploads.current.bytes.done);
          } else {
            uploads.uploadChart.data.datasets[0].data[0] = 0;
            uploads.uploadChart.data.datasets[0].data[1] = 0;
          }
          uploads.uploadChart.update();
        }
      } catch (err) {
        console.error(err);
      }
    }
  });

  var space = ($scope.space = {
    status: "waiting",
    maxStorage: 0,
    usedStorage: 0,
    graphicClass: "",
    blocks: [],
    refresh: () => {
      return new Promise((resolve, reject) => {
        space.status = "loading";
        Block.find(
          { _id: { $in: G.user.plan.blocks } },
          { latestSize: 1, maxSize: 1 },
          (err, blocks) => {
            if (err) return reject(["Couldn't load blocks", err]);
            space.usedStorage = G.user.plan.latestTotalSize;
            space.maxStorage = G.user.plan.maxTotalSize;
            space.blocks = blocks.map(block => {
              let blockObj = {
                id: block.id,
                usedStorage: block.latestSize,
                percentUsed:
                  ((block.latestSize / 1073741824) * 100) / block.maxSize
              };
              let usedRatio = (blockObj.usedStorage / block.maxSize).toFixed(2);
              if (usedRatio > 0) {
                blockObj.graphicClass = `{'flex-grow': ${usedRatio}}`;
              } else {
                blockObj.graphicClass = "{'flex-grow': 0.01}";
              }
              return blockObj;
            });
            let usedRatio = (space.usedStorage / space.maxStorage).toFixed(2);
            if (usedRatio > 0) {
              space.graphicClass = `{'flex-grow': ${usedRatio}}`;
            } else {
              space.graphicClass = "{'flex-grow': 0.01}";
            }
            console.log(space);
            space.status = "";
            resolve();
          }
        );
      });
    }
  });

  var plan = ($scope.plan = {
    status: "waiting",
    maxTotalSize: 0,
    price: 0,
    cycle: "",
    nextPayment: "",
    chart: null,
    refresh: () => {
      return new Promise((resolve, reject) => {
        plan.status = "loading";
        plan.maxTotalSize = G.user.plan.maxTotalSize / 1073741824;
        if (plan.maxTotalSize != plan.maxTotalSize.toFixed(0)) {
          plan.maxTotalSize = plan.maxTotalSize.toFixed(1);
        }
        Tier.findOne(
          { id: G.user.plan.tier },
          { pricePerMonth: 1 },
          (err, tier) => {
            if (err || !tier) {
              return reject([
                "Couldn't get your info",
                err || new Error("Tier not found")
              ]);
            }
            switch (G.user.plan.lengthInMonths) {
              case 1:
                plan.cycle = "MONTHLY";
                break;
              case 4:
                plan.cycle = "QUATERLY";
                break;
              case 12:
                plan.cycle = "ANUALLY";
                break;
              default:
                plan.cycle = `EVERY ${G.user.plan.lengthInMonths} MONTHS`;
            }
            plan.price = tier.pricePerMonth * G.user.plan.lengthInMonths;
            let formatDate = date => {
              return `${date.getDate()} 
            ${G.longMonths[date.getMonth()]} ${date.getFullYear()}`;
            };
            let periodEnd = new Date(G.user.plan.currentPeriodStart);
            periodEnd.setFullYear(
              periodEnd.getFullYear() +
                Math.floor(G.user.plan.lengthInMonths / 12)
            );
            periodEnd.setMonth(
              (periodEnd.getMonth() + G.user.plan.lengthInMonths) % 12
            );
            plan.nextPayment = formatDate(periodEnd);
            plan.status = "";
            resolve();
          }
        );
      });
    },
    defineChart: () => {
      plan.chart = new Chart(document.getElementById("line-graph"), {
        type: "line",
        data: {
          labels: [],
          datasets: [
            {
              label: "Storage Use Trend",
              data: [],
              borderColor: "#4caf50",
              fill: false
            }
          ]
        },
        options: {
          legend: { display: true },
          layout: {
            // padding: { top: -20 }
          }
        }
      });
    },
    updateChart: scale => {
      let groupById = {};
      switch (scale) {
        case "day":
          groupById.day = { $dayOfMonth: "$log.sizeHistory.date" };
        case "month":
          groupById.month = { $month: "$log.sizeHistory.date" };
        case "year":
          groupById.year = { $year: "$log.sizeHistory.date" };
          break;
        case "week":
          groupById.year = { $year: "$log.sizeHistory.date" };
          groupById.week = { $week: "$log.sizeHistory.date" };
          break;
        default:
          return G.notifyError(
            "Failed to draw storage chart",
            new Error("Invalid scale type")
          );
      }
      console.log(groupById);
      Block.aggregate(
        [
          { $match: { owner: G.user._id } },
          { $project: { _id: 1, "log.sizeHistory": "$log.sizeHistory.list" } },
          { $unwind: "$log.sizeHistory" },
          {
            $group: Object.assign(
              { _id: groupById },
              {
                size: { $sum: "$log.sizeHistory.size" }
              }
            )
          }
        ],
        (err, blocks) => {
          if (err) return G.notifyError("Failed to draw storage chart", err);
          console.log(blocks);
          let storageScale = [1, "bytes"];
          blocks.forEach(block => {
            if (block.size >= 1073741824 && storageScale[0] < 1073741824) {
              storageScale = [1073741824, "Gb"];
            }
            if (block.size >= 1048576 && storageScale[0] < 1048576) {
              storageScale = [1048576, "Mb"];
            }
            if (block.size >= 1024 && storageScale[0] < 1024) {
              storageScale = [1024, "Kb"];
            }
          });
          blocks.forEach(block => {
            let blockDate = new Date();
            let dateFormat;
            switch (scale) {
              case "day":
                blockDate.setDate(block._id.day);
              case "month":
                blockDate.setMonth(block._id.month);
              case "year":
                blockDate.setFullYear(block._id.year);
                dateFormat = blockDate.getFullYear();
                break;
              case "week":
                blockDate.setFullYear(block._id.year);
                blockDate.setDate(block._id.week * 7);
                let endDate = new Date(blockDate);
                endDate.setDate(endDate.getDate + 7);
                let fStartMonth = G.shortMonths[blockDate.getMonth()];
                let fEndMonth = G.shortMonths[endDate.getMonth()];
                if (fStartMonth == fEndMonth) {
                  dateFormat = `${blockDate.getDate()}-${endDate.getDate()} ${fStartMonth}`;
                } else {
                  dateFormat = `${blockDate.getDate()} ${fStartMonth} - ${endDate.getDate()} ${fEndMonth}`;
                }
                break;
            }
            if (scale == "month") {
              dateFormat = G.shortMonths[blockDate.getMonth()];
            } else if (scale == "day") {
              dateFormat = `${blockDate.getDate()} ${
                G.shortMonths[blockDate.getMonth()]
              }`;
            }
            plan.chart.data.datasets[0].data.push(
              Math.round(block.size / storageScale[0])
            );
            plan.chart.data.labels.push(dateFormat.toString());
          });
          // let periodEnd = new Date(G.user.plan.currentPeriodStart);
          // periodEnd.setFullYear(
          //   periodEnd.getFullYear() +
          //     Math.floor(G.user.plan.lengthInMonths / 12)
          // );
          // periodEnd.setMonth(
          //   (periodEnd.getMonth() + G.user.plan.lengthInMonths) % 12
          // );
          // if (events.find(e => e.date.getMonth() == periodEnd.getMonth())) {
          //   plan.chart.data.labels.push(
          //     `${
          //       G.shortMonths[periodEnd.getMonth()]
          //     } ${periodEnd.getFullYear()}`
          //   );
          // } else {
          //   plan.chart.data.labels.push(
          //     `${G.shortMonths[periodEnd.getMonth()]} (estimated)`
          //   );
          // }
          // if (plan.chart.data.datasets[0].data.length > 0) {
          //   plan.chart.data.datasets[0].data.push(
          //     plan.chart.data.datasets[0].data[
          //       plan.chart.data.datasets[0].data.length - 1
          //     ] +
          //       Math.round(
          //         events.length > 0
          //           ? events.reduce(
          //               (acc, cur) => (acc += cur.size / storageScale[0]),
          //               0
          //             ) / events.length
          //           : 0
          //       )
          //   );
          // }
          plan.chart.data.datasets[0].label = `Storage use in ${
            storageScale[1]
          }`;
          console.log(plan.chart.data.datasets[0], plan.chart.data.labels);
          plan.chart.update();
          $scope.$apply();
        }
      );
    }
  });

  var email = ($scope.email = {
    restarting: false,
    sending: false,
    sendingTask: null,
    sent: false,
    onVerified: () => {
      email.restarting = true;
      G.logout(() => G.restart());
    },
    resend: () => {
      email.sending = true;
      $interval.cancel(email.sendingTask);
      email.sent = false;
      $http
        .post(
          `${G.API_DOMAIN}/client/auth/sendEmailVerification`,
          { uid: G.profile.sub },
          G.oauthHeader()
        )
        .then(() => {
          email.sent = true;
          email.sendingTask = $interval(
            () => {
              email.sent = false;
            },
            4000,
            1
          );
        })
        .catch(err => G.notifyError("Couldn't send email", err))
        .finally(() => (email.sending = false));
    }
  });

  // ---------------------------------------

  stage.status = "loading";

  G.getUser(
    (err, user) => {
      if (err || !user) {
        stage.status = "error";
        return G.notifyError("We couldn't get your user info", err);
      }
      G.user = JSON.parse(JSON.stringify(user));
      if (user.plan) {
        uploads.defineListeners();
        Promise.all([uploads.refresh(), space.refresh(), plan.refresh()])
          .then(() => {
            $scope.$apply(() => {
              stage.status = "";
              // uploads.current = {
              //   filename: "/frontend/img",
              //   version: 3,
              //   size: "32 Mb",
              //   path:
              //     "C:\\Users\\Victor\\GitHub\\binderv4\\electron\\src\\frontend\\img"
              // };
              // uploads.queue = [
              //   {
              //     filename: "/frontend/img",
              //     path:
              //       "C:\\Users\\Victor\\GitHub\\binderv4\\electron\\src\\frontend\\img",
              //     isNew: true,
              //     pendingRetry: true
              //   },
              //   {
              //     filename: "/Desktop/Clutter",
              //     path: "C:UsersVictorDesktopClutter",
              //     isNew: false
              //   },
              //   {
              //     filename: "/Desktop/saturday",
              //     path: "C:UsersVictorDesktopsaturday",
              //     isNew: true,
              //     pendingRetry: false
              //   },
              //   {
              //     filename: "/frontend/img",
              //     path:
              //       "C:\\Users\\Victor\\GitHub\\binderv4\\electron\\src\\frontend\\img",
              //     isNew: true,
              //     pendingRetry: true
              //   },
              //   {
              //     filename: "/Desktop/Clutter",
              //     path: "C:UsersVictorDesktopClutter",
              //     isNew: false
              //   },
              //   {
              //     filename: "/Desktop/saturday",
              //     path: "C:UsersVictorDesktopsaturday",
              //     isNew: true,
              //     pendingRetry: false
              //   }
              // ];
              $scope.$$postDigest(() => {
                uploads.defineUploadChart();
                plan.defineChart();
                plan.updateChart("week");
              });
            });
          })
          .catch(handleError);
      } else {
        stage.status = "";
      }
      $scope.$apply();
    },
    "plan.tier",
    "plan.lengthInMonths",
    "plan.currentPeriodStart",
    "plan.latestTotalSize",
    "plan.maxTotalSize"
  );

  function smallerPath(path, estLength) {
    let orgLength = path.length;
    let startIndex = path.length - estLength;
    path = path.substr(startIndex < 0 ? 0 : startIndex, estLength);
    if (path.includes("/")) {
      path = path.substr(path.indexOf("/"));
    } else if (orgLength > estLength) {
      path = "…" + path;
    }
    return path;
  }

  function handleError(err, defaultMsg) {
    if (err[0]) {
      G.notifyError(err[0], err[1]);
    } else {
      G.notifyError(defaultMsg || "Something went wrong", err);
    }
  }
});
