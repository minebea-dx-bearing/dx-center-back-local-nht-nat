// local-backend/test/analysisChartUtils.test.js
const moment = require("moment-timezone");

let passed = 0;
let failed = 0;

const assertEq = (label, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (pass) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual  : ${JSON.stringify(actual)}`);
  }
};

const { generateData, summarize, calcTargetProd } = require("../util/analysisChartUtils");

console.log("=========================================================");
console.log(" analysisChartUtils — unit tests");
console.log("=========================================================");

// calcTargetProd
console.log("\n[calcTargetProd — uses target_special when set]");
assertEq(
  "target_special overrides formula",
  calcTargetProd(3600, { target_special: "100", target_ct: 10, target_utl: 80, target_yield: 95, ring_factor: 1 }),
  Number((100 / 86400) * 3600)
);

console.log("\n[calcTargetProd — formula when target_special is empty]");
assertEq(
  "formula: seconds/ct * utl * yield * ring",
  calcTargetProd(3600, { target_special: "", target_ct: 10, target_utl: 80, target_yield: 100, ring_factor: 1 }),
  (3600 / 10) * (80 / 100) * (100 / 100) * 1
);

// generateData
const rawRecord = {
  mc_no: "MC01",
  status_alarm: "mc_run",
  occurred_start: "2026-05-13T01:00:00.000Z",
  occurred_end:   "2026-05-13T02:00:00.000Z",
  duration_seconds: 3600,
};

console.log("\n[generateData — RUN status gets green color]");
const generated = generateData([rawRecord]);
assertEq("one item returned", generated.length, 1);
assertEq("RUN color is #16C809", generated[0].color, "#16C809");
assertEq("itemStyle.color matches", generated[0].itemStyle.color, "#16C809");
assertEq("name equals status_alarm", generated[0].name, "mc_run");
assertEq("value[0] is 0", generated[0].value[0], 0);
assertEq("value[3] is duration_seconds", generated[0].value[3], 3600);

console.log("\n[generateData — STOP status gets red color]");
const stopRecord = { ...rawRecord, status_alarm: "STOP" };
const generatedStop = generateData([stopRecord]);
assertEq("STOP color is #F40B0B", generatedStop[0].color, "#F40B0B");

console.log("\n[generateData — unknown alarm gets palette color, same alarm same color]");
const alarmA = { ...rawRecord, status_alarm: "ALARM_XYZ" };
const alarmACopy = { ...rawRecord, status_alarm: "ALARM_XYZ" };
const generatedAlarms = generateData([alarmA, alarmACopy]);
assertEq("same alarm, same color", generatedAlarms[0].color, generatedAlarms[1].color);

// summarize
console.log("\n[summarize — aggregates duration and count by alarm]");
const coloredRecords = generateData([
  { ...rawRecord, status_alarm: "STOP", duration_seconds: 600 },
  { ...rawRecord, status_alarm: "STOP", duration_seconds: 400 },
  { ...rawRecord, status_alarm: "mc_run", duration_seconds: 1000 },
]);
const summary = summarize(coloredRecords);
const stopEntry = summary.find((r) => r.alarm === "STOP");
const runEntry  = summary.find((r) => r.alarm === "mc_run");
assertEq("STOP count is 2", stopEntry.count, 2);
assertEq("STOP duration is 1000", stopEntry.duration, 1000);
assertEq("run count is 1", runEntry.count, 1);
assertEq("summary items have no field", summary.length, 2);

console.log("\n=========================================================");
console.log(` Result: ${passed} passed, ${failed} failed`);
console.log("=========================================================");
if (failed > 0) process.exit(1);
