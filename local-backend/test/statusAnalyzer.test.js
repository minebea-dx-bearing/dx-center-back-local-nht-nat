// local-backend/test/statusAnalyzer.test.js
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

const { getStatusTimeline } = require("../util/statusAnalyzer");

console.log("=========================================================");
console.log(" statusAnalyzer — contract tests");
console.log("=========================================================");

const fakeRows = [
  { mc_no: "MC01", status_alarm: "mc_run", occurred_start: "2026-05-13 07:00:00", occurred_end: "2026-05-13 08:00:00", duration_seconds: 3600 },
];

let capturedSql = null;
let capturedOpts = null;

const mockDbms = {
  query: (sql, opts) => {
    capturedSql = sql;
    capturedOpts = opts;
    return Promise.resolve([fakeRows]);
  },
};

const config = {
  databaseAlarm: "[test_db].[dbo].[DATA_ALARMLIS_TEST]",
  databaseIot:   "[test_db].[dbo].[MONITOR_IOT]",
};

(async () => {
  console.log("\n[getStatusTimeline — returns result rows]");
  const result = await getStatusTimeline(mockDbms, "MC01", "2026-05-13", config);
  assertEq("returns the rows array", result, fakeRows);

  console.log("\n[getStatusTimeline — SQL injects table names correctly]");
  assertEq("databaseAlarm in SQL", capturedSql.includes("[test_db].[dbo].[DATA_ALARMLIS_TEST]"), true);
  assertEq("databaseIot in SQL", capturedSql.includes("[test_db].[dbo].[MONITOR_IOT]"), true);

  console.log("\n[getStatusTimeline — uses parameterized replacements]");
  assertEq("mc_no replacement present", capturedOpts.replacements.mc_no, "MC01");
  assertEq("startDate equals 07:00", capturedOpts.replacements.startDate, "2026-05-13 07:00");
  assertEq("targetEndDate equals next day 07:00", capturedOpts.replacements.targetEndDate, "2026-05-14 07:00");

  console.log("\n[getStatusTimeline — respects custom startHour/startMinute]");
  capturedSql = null;
  capturedOpts = null;
  await getStatusTimeline(mockDbms, "MC01", "2026-05-13", {
    ...config,
    startHour: 6,
    startMinute: 30,
  });
  assertEq("custom startDate equals 06:30", capturedOpts.replacements.startDate, "2026-05-13 06:30");
  assertEq("custom targetEndDate equals next day 06:30", capturedOpts.replacements.targetEndDate, "2026-05-14 06:30");

  console.log("\n=========================================================");
  console.log(` Result: ${passed} passed, ${failed} failed`);
  console.log("=========================================================");
  if (failed > 0) process.exit(1);
})();
