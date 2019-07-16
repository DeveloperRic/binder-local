// home ctrl
app.controller("homeCtrl", function($scope, $rootScope, $http, $interval) {
  const G = $rootScope.G;
  const Chart = require("chart.js");
  var Block = G.clientModels.Block;
  var Tier = G.clientModels.Tier;
  var User = G.clientModels.User;

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
      G.ipcRenderer.on("upload-resume", args => {
        console.log("==== got resume ====");
        if (uploads.status != "") return;
        if (args[0]) {
          try {
            uploads.queue.length = 0;
            args[0].changed.forEach(item => {
              uploads.processItemUpdate(item);
            });
          } catch (err) {
            return $scope.$apply(() =>
              G.notifyError("Failed to get upload status", err)
            );
          }
        }
        uploads.updatePercentAndCurrent();
        $scope.$apply();
      });
      G.ipcRenderer.on("upload-progress", args => {
        console.log("==== got progress ====");
        if (uploads.status != "") return;
        uploads.processItemUpdate(args[0], args[1]);
        uploads.updatePercentAndCurrent();
        $scope.$apply();
      });
      G.ipcRenderer.on("upload-success", args => {
        console.log("==== got success ====");
        if (uploads.status != "") return;
        let itemIndex = uploads.queue.findIndex(u => u.path == args[0].path);
        if (itemIndex >= 0) {
          uploads.queue.splice(itemIndex, 1);
          uploads.updatePercentAndCurrent();
          $scope.$apply();
        }
      });
      G.ipcRenderer.on("upload-failed", args => {
        console.log("==== got failed ====");
        if (uploads.status != "") return;
        let itemIndex = uploads.queue.findIndex(u => u.path == args[0].path);
        if (itemIndex >= 0) {
          uploads.queue.splice(itemIndex, 1);
          uploads.failed.unshift(uploads.fileDatToQueueItem(args[0]));
          uploads.updatePercentAndCurrent();
          $scope.$apply();
        }
      });
      G.ipcRenderer.on("upload-all-uploaded", args => {
        console.log("==== got all-done ====");
        if (uploads.status != "") return;
        let since = args[0].created;
        //TODO show list of uploaded files
      });
      G.ipcRenderer.on("upload-all-failed", args => {
        console.log("==== got all-failed ====");
        if (uploads.status != "") return;
        uploads.queue.length = 0;
        args[0].changed.forEach(item => {
          uploads.processItemUpdate(item);
        });
        uploads.queue
          .splice(0)
          .reverse()
          .forEach(item => uploads.failed.unshift(item));
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
              data: [100, 0],
              backgroundColor: ["#4caf50"]
            }
          ],
          labels: ["% Completed", "% Remaining"]
        },
        options: {
          cutoutPercentage: 70
        }
      });
    },
    refresh: () => {
      return new Promise((resolve, reject) => {
        uploads.status = "loading";
        setImmediate(() => {
          let schedule = G.ipcRenderer.sendSync("upload-status");
          if (schedule) {
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
        // uploads.queue[itemIndex].bytes = fileDat.bytes;
        // uploads.queue[itemIndex].parts = fileDat.parts;
        // uploads.queue[itemIndex].size = size;
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
        filename: smallerPath(fixPathSlashes(fileDat.path), 10),
        isNew: fileDat.isNew,
        version: fileDat.version,
        bytes: fileDat.bytes,
        parts: fileDat.parts,
        size: size
      };
    },
    updatePercentAndCurrent: () => {
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
        uploads.overallPercent = 100;
      }
      uploads.current = uploads.queue[0];
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
    price: 0,
    cycle: "",
    nextPayment: "",
    chart: null,
    refresh: () => {
      return new Promise((resolve, reject) => {
        plan.status = "loading";
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
            ${
              [
                "January",
                "February",
                "March",
                "April",
                "May",
                "June",
                "July",
                "August",
                "September",
                "October",
                "November",
                "December"
              ][date.getMonth()]
            } ${date.getFullYear()}`;
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
    updateChart: () => {
      Block.find(
        { owner: G.user._id },
        { "log.sizeHistory": 1 },
        (err, blocks) => {
          if (err) return G.notifyError("Failed to draw storage chart", err);
          let events = [];
          let storageScale = [1, "bytes"];
          blocks.forEach(block => {
            block.log.sizeHistory.forEach(item => {
              // find any existing event in the same month
              // and increment its size property
              let itemDate = new Date(item.date);
              let event = events.find(
                e =>
                  itemDate.getMonth() == e.date.getMonth() &&
                  itemDate.getFullYear() == e.date.getFullYear()
              );
              if (item.size >= 1073741824 && storageScale[0] < 1073741824) {
                storageScale = [1073741824, "Gb"];
              }
              if (item.size >= 1048576 && storageScale[0] < 1048576) {
                storageScale = [1048576, "Mb"];
              }
              if (item.size >= 1024 && storageScale[0] < 1024) {
                storageScale = [1024, "Kb"];
              }
              if (!event) {
                itemDate.setDate(1);
                events.push({
                  date: itemDate,
                  size: item.size
                });
              } else {
                event.size += item.size;
              }
            });
          });
          console.log(events);
          let monthArray = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec"
          ];
          for (let i in events) {
            let event = events[i];
            plan.chart.data.datasets[0].data.push(
              Math.round(event.size / storageScale[0])
            );
            plan.chart.data.labels.push(`${monthArray[event.date.getMonth()]}`);
          }
          let periodEnd = new Date(G.user.plan.currentPeriodStart);
          periodEnd.setFullYear(
            periodEnd.getFullYear() +
              Math.floor(G.user.plan.lengthInMonths / 12)
          );
          periodEnd.setMonth(
            (periodEnd.getMonth() + G.user.plan.lengthInMonths) % 12
          );
          if (events.find(e => e.date.getMonth() == periodEnd.getMonth())) {
            plan.chart.data.labels.push(
              `${monthArray[periodEnd.getMonth()]} ${periodEnd.getFullYear()}`
            );
          } else {
            plan.chart.data.labels.push(
              `${monthArray[periodEnd.getMonth()]} (estimated)`
            );
          }
          if (plan.chart.data.datasets[0].data.length > 0) {
            plan.chart.data.datasets[0].data.push(
              plan.chart.data.datasets[0].data[
                plan.chart.data.datasets[0].data.length - 1
              ] +
                Math.round(
                  events.length > 0
                    ? events.reduce(
                        (acc, cur) => (acc += cur.size / storageScale[0]),
                        0
                      ) / events.length
                    : 0
                )
            );
          }
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
          `https://${G.API_DOMAIN}/client/auth/sendEmailVerification`,
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

  G.getUser((err, user) => {
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
            $scope.$$postDigest(() => {
              uploads.defineUploadChart();
              plan.defineChart();
              plan.updateChart();
            });
          });
        })
        .catch(args =>
          $scope.$apply(() => {
            stage.status = "error";
            G.notifyError(args[0], args[1]);
          })
        );
    } else {
      stage.status = "";
    }
    $scope.$apply();
  });

  function fixPathSlashes(path) {
    return path.replace(new RegExp(G.regexEscape("\\"), "g"), "/");
  }

  function smallerPath(path, estLength) {
    let orgLength = path.length;
    path = path.substr(path.length - estLength, estLength);
    if (path.includes("/")) {
      path = path.substr(path.indexOf("/"));
    } else if (orgLength > estLength) {
      path = "..." + path;
    }
    return path;
  }
});
