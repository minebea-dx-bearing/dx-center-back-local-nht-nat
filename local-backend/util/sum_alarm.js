/**
 * ฟังก์ชันสำหรับ Query ข้อมูล Master ของเครื่องจักรล่าสุด
 * @param {object} dbms - Sequelize instance สำหรับการเชื่อมต่อฐานข้อมูล
 * @param {string} DATABASE_ALARM - ชื่อตาราง Alarm
 * @param {string} DATABASE_SUM_ALARM - ชื่อตาราง Alarm ที่จะสรุปใส่
 * @returns {Promise<Array>} - Array ของข้อมูลเครื่องจักร
 */

const moment = require("moment");

const sum_alarm = async (dbms, DATABASE_ALARM, DATABASE_SUM_ALARM) => {
  const now = moment();
  const remainder = now.minute() % 5;
  const time_end = now.subtract(remainder, "minutes").second(0).millisecond(0);
  const time_start = moment(time_end).subtract(5, "minutes");

  // const time_end = moment("2025-11-02 11:30");
  // const time_start = moment(time_end).subtract(5, "days");

  try {
    const response_alarm = await dbms.query(
      `
        DECLARE @start_date DATETIME = '${time_start.format("YYYY-MM-DD HH:mm")}';
        DECLARE @end_date DATETIME = '${time_end.format("YYYY-MM-DD HH:mm")}';
        DECLARE @start_date_p1 DATETIME = DATEADD(HOUR, -2, @start_date);    -- เวลาที่ต้องการลบไป 2hr เพื่อดึง alarm ตัวก่อนหน้า --
        DECLARE @end_date_p1 DATETIME = DATEADD(HOUR, 2, @end_date);        -- เวลาที่ต้องการบวกไป 2hr เพื่อดึง alarm ตัวหลัง --

        WITH [base_alarm] AS (
            -- เรียก data ทั้งหมด ก่อนและหลัง 1hr --
            SELECT
                [mc_no],
            [occurred],
                [alarm],
                CASE
                    WHEN RIGHT([alarm], 1) = '_' THEN LEFT([alarm], LEN([alarm]) - 1)
                    ELSE [alarm]
                END AS [alarm_base],
                CASE
                    WHEN RIGHT([alarm], 1) = '_' THEN 'after'
                    ELSE 'before'
                END AS [alarm_type]
            FROM ${DATABASE_ALARM}
            WHERE [occurred] BETWEEN @start_date_p1 AND @end_date_p1
        ),
        [with_pairing] AS (
            -- จับคู่ alarm กับ alarm_ --
            SELECT *,
                LEAD([occurred]) OVER (PARTITION BY [mc_no], [alarm_base] ORDER BY [occurred]) AS [occurred_next],
                LEAD([alarm_type]) OVER (PARTITION BY [mc_no], [alarm_base] ORDER BY [occurred]) AS [next_type]
            FROM [base_alarm]
        ),
        [paired_alarms] AS (
            -- filter เฉพาะตัวที่มี alarm , alarm_ และ check ตัว alarm ที่เกิดซ้อนอยู่ใน alarm อีกตัว --
            SELECT
                [mc_no],
                [alarm_base],
                [occurred] AS [occurred_start],
                [occurred_next] AS [occurred_end]
            FROM [with_pairing]
            WHERE [alarm_type] = 'before' AND [next_type] = 'after'
        ),
        [base_monitor_iot] AS (
            SELECT
                [mc_no],
                [registered],
                CAST(broker AS FLOAT) AS [broker_f]
            FROM ${DATABASE_ALARM.split(".")[0]}.[dbo].[MONITOR_IOT]
            WHERE registered BETWEEN @start_date_p1 AND @end_date_p1
        ),
        [mark] AS (
            SELECT
                [mc_no],
                [registered],
                [broker_f],
                CASE WHEN [broker_f] = 0 THEN 1 ELSE 0 END AS [is_zero],
                LAG(CASE WHEN [broker_f] = 0 THEN 1 ELSE 0 END)
                    OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [prev_is_zero],
                LEAD(CASE WHEN [broker_f] = 0 THEN 1 ELSE 0 END)
                    OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [next_is_zero],
                LEAD([registered])
                    OVER (PARTITION BY [mc_no] ORDER BY [registered]) AS [next_registered]
            FROM [base_monitor_iot]
        ),
        [flagged] AS (
            SELECT
                *,
                CASE WHEN [is_zero] = 1 AND ISNULL([prev_is_zero],0) = 0 THEN 1 ELSE 0 END AS [start_flag],
                CASE WHEN [is_zero] = 1 AND ISNULL([next_is_zero],0) = 0 THEN 1 ELSE 0 END AS [end_flag]
            FROM [mark]
        ),
        [grpz] AS (
            -- เก็บเฉพาะแถวที่ broker = 0 แล้วทำ running group id สำหรับช่วงต่อเนื่อง
            SELECT
                *,
                SUM(CASE WHEN [start_flag] = 1 THEN 1 ELSE 0 END)
                    OVER (PARTITION BY [mc_no] ORDER BY [registered] ROWS UNBOUNDED PRECEDING) AS [grp]
            FROM [flagged]
            WHERE [is_zero] = 1
        ),
        [summary_connection_lose] AS (
          SELECT
            [mc_no],
            'connection lose' AS [alarm_base],
            MIN(registered) AS [occurred_start],
            MAX(CASE WHEN [end_flag] = 1 THEN ISNULL([next_registered], [registered]) END) AS [occurred_end]
          FROM [grpz]
          GROUP BY [mc_no], [grp]
        ),
        [conbine_connection_lose] AS (
          SELECT * FROM [summary_connection_lose]
            UNION ALL
            SELECT * FROM [paired_alarms]
        ),
        [with_max_prev] AS (
            SELECT *,
                MAX([occurred_end]) OVER (
                    PARTITION BY [mc_no]
                    ORDER BY [occurred_start]
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS [max_prev_end]
            FROM [conbine_connection_lose]
        ),
        [check_duplicate] AS (
            SELECT
                [mc_no],
                [alarm_base],
                [occurred_start],
                [occurred_end],
                CASE
                    WHEN [max_prev_end] IS NOT NULL AND [occurred_end] <= [max_prev_end] THEN 1
                    ELSE 0
                END AS [duplicate]
            FROM [with_max_prev]
        ),
        [clamped_alarms] AS (
            -- ตัดตัวที่เป็น alarm ซ้อนใน alarm อีกตัวออกและเพิ่มเวลาก่อนและหลังเพื่อคำนวณ --
            SELECT
                [mc_no],
                [alarm_base],
                [occurred_start],
                [occurred_end],
                LAG([alarm_base]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_end]) AS [previous_alarm],
                LAG([occurred_end]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_end]) AS [previous_occurred],
                DATEDIFF(SECOND, LAG([occurred_end]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_end]), [occurred_start]) AS [previous_gap_seconds],
                LEAD([alarm_base]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [next_alarm],
                LEAD([occurred_start]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start]) AS [next_occurred],
                DATEDIFF(SECOND, [occurred_end], LEAD([occurred_start]) OVER (PARTITION BY [mc_no] ORDER BY [occurred_start])) AS [next_gap_seconds]
            FROM [check_duplicate]
            WHERE [duplicate] = 0
        ),
        [edit_occurred] AS (
            -- filter เอาเฉพาะเวลาที่ต้องการ , ถ้า alarm = mc_run แล้วเวลาซ้อนกับ alarm ตัวอื่นจะตัดเวลา alarm ตัวนั้นออก , ถ้าเป็น alarm1 เหลื่อม alarm2 จะตัดเวลา alarm1 ออกตามที่เหลื่อม --
            SELECT
                *,
                CASE
                    WHEN [previous_gap_seconds] < 0 AND [previous_alarm] = 'mc_run' THEN [previous_occurred]
                    WHEN [previous_gap_seconds] < 0 THEN [previous_occurred]
                    ELSE [occurred_start]
                END AS [new_occurred_start]
            FROM [clamped_alarms]
        ),
        [insert_stop] AS (
            -- เพิ่มเวลา STOP เข้าไปแทนที่ช่วงเวลาที่ไม่มี alarm --
            SELECT
                [mc_no],
                'STOP' AS [alarm_base],
                [occurred_end] AS [occurred_start],
                [next_occurred] AS [occurred_end]
            FROM [edit_occurred]
            WHERE [next_gap_seconds] > 0
        ),
        [insert_stop_end] AS (
            -- เพิ่มเวลา STOP เข้าไปแทนที่ช่วงเวลาที่ไม่มี alarm --
            SELECT
                [mc_no],
                'STOP' AS [alarm_base],
                [occurred_end] AS [occurred_start],
                @end_date AS [occurred_end]
            FROM [edit_occurred]
            WHERE [next_gap_seconds] IS NULL
        ),
        [insert_stop_start] AS (
            -- เพิ่มเวลา STOP เข้าไปแทนที่ช่วงเวลาที่ไม่มี alarm --
            SELECT
                [mc_no],
                'STOP' AS [alarm_base],
                @start_date AS [occurred_start],
                [new_occurred_start] AS [occurred_end]
            FROM [edit_occurred]
            WHERE [previous_gap_seconds] IS NULL
        ),
        [combine_result] AS (
            -- รวม alarm ทั้งหมดกับ STOP เข้าด้วยกัน --
            SELECT UPPER([mc_no]) AS [mc_no], UPPER([alarm_base]) AS [alarm_base], [new_occurred_start] AS [occurred_start], [occurred_end] FROM [edit_occurred]
            UNION ALL
            SELECT UPPER([mc_no]) AS [mc_no], [alarm_base], [occurred_start], [occurred_end] FROM [insert_stop]
          UNION ALL
          SELECT UPPER([mc_no]) AS [mc_no], [alarm_base], [occurred_start], [occurred_end] FROM [insert_stop_end]
          UNION ALL
          SELECT UPPER([mc_no]) AS [mc_no], [alarm_base], [occurred_start], [occurred_end] FROM [insert_stop_start]
        ),
        [edit_time_result] AS (
            -- ปัดเวลาให้เท่ากับเวลาที่ต้องการ --
            SELECT
                [mc_no],
                [alarm_base],
                CASE 
                    WHEN [occurred_start] < @start_date THEN CAST(@start_date AS datetime)    -- ปัดเวลาหัวให้เท่ากับเวลาที่ต้องการ --
                    ELSE [occurred_start]
                END AS [occurred_start],
                CASE 
                    WHEN [occurred_end] > @end_date THEN CAST(@end_date AS datetime)    -- ปัดเวลาท้ายให้เท่ากับเวลาที่ต้องการ --
                    ELSE [occurred_end]
                END AS [occurred_end]
            FROM [combine_result]
        ),
        [filter_result] AS (
            -- หลังปัดเวลาเสร็จ filter เอาข้อมูลที่เวลาผิดทิ้ง --
            SELECT * FROM [edit_time_result]
            WHERE
                [occurred_end] > [occurred_start]
        )
        SELECT
            *,
            DATEDIFF(SECOND, [occurred_start], [occurred_end]) AS [duration_seconds]
        FROM [filter_result]
        ORDER BY [mc_no], [occurred_start]
      `
    );

    const data_alarm = response_alarm[0].length > 0 ? response_alarm[0] : [];

    const response_sum_alarm = await dbms.query(
      `
        DECLARE @start_date DATETIME = '${time_start.format("YYYY-MM-DD HH:mm")}';
        DECLARE @end_date DATETIME = '${time_end.format("YYYY-MM-DD HH:mm")}';

        SELECT
          [registered]
            ,[mc_no]
            ,[status_alarm]
            ,[occurred_start]
            ,[occurred_end]
            ,[duration_seconds]
            ,[active]
        FROM ${DATABASE_SUM_ALARM}
        WHERE
          [occurred_start] BETWEEN @start_date AND @end_date OR [active] IN (1, 2)
      `
    );
    const data_sum_alarm = response_sum_alarm[0].length > 0 ? response_sum_alarm[0] : [];
    for (let i = 0; i < data_alarm.length; i++) {
      // check ถ้า ซ้ำไม่ให้ insert
      const findDataForNewInsert = data_sum_alarm.find(
        (item) =>
          item.mc_no === data_alarm[i].mc_no &&
          item.status_alarm === data_alarm[i].alarm_base &&
          moment(data_alarm[i].occurred_start).isBetween(moment(item.occurred_start), moment(item.occurred_end), null, "[]") &&
          moment(data_alarm[i].occurred_end).isBetween(moment(item.occurred_start), moment(item.occurred_end), null, "[]") ||
          moment(data_alarm[i].occurred_start).isSame(moment(item.occurred_end))
      );
      if (!findDataForNewInsert) {
        // console.log("Insert", data_alarm[i]);
        await dbms.query(
          `
              INSERT INTO ${DATABASE_SUM_ALARM}
              (
                [registered]
                ,[mc_no]
                ,[status_alarm]
                ,[occurred_start]
                ,[occurred_end]
                ,[duration_seconds]
                ,[active]
              )
              VALUES
              (
                '${moment().format("YYYY-MM-DD HH:mm:ss.SSS")}'
                ,'${data_alarm[i].mc_no}'
                ,'${data_alarm[i].alarm_base}'
                ,'${moment(data_alarm[i].occurred_start).utc().format("YYYY-MM-DD HH:mm:ss.SSS")}'
                ,'${moment(data_alarm[i].occurred_end).utc().format("YYYY-MM-DD HH:mm:ss.SSS")}'
                ,${data_alarm[i].duration_seconds}
                ,${
                  moment(data_alarm[i].occurred_end).utc().format("YYYY-MM-DD HH:mm:ss.SSS") === time_end.format("YYYY-MM-DD HH:mm:ss.SSS") ? 1 : 0
                }
              )
          `
        );
      }

      const findDataForUpdate = data_sum_alarm.find(
        (item) =>
          item.active === 1 &&
          item.mc_no === data_alarm[i].mc_no &&
          item.status_alarm === data_alarm[i].alarm_base &&
          moment(item.occurred_end).isSame(moment(data_alarm[i].occurred_start), "second")
      );
      if (findDataForUpdate) {
        // console.log("UPDATE", findDataForUpdate);
        await dbms.query(
          `
              UPDATE ${DATABASE_SUM_ALARM}
              SET
              [occurred_end] = '${moment(data_alarm[i].occurred_end).utc().format("YYYY-MM-DD HH:mm:ss.SSS")}',
              [duration_seconds] = ${findDataForUpdate.duration_seconds + data_alarm[i].duration_seconds},
              [active] = ${
                moment(data_alarm[i].occurred_end).utc().format("YYYY-MM-DD HH:mm:ss.SSS") === time_end.format("YYYY-MM-DD HH:mm:ss.SSS") ? 1 : 2
              }
              WHERE [active] = 1 AND [mc_no] = '${data_alarm[i].mc_no}' AND [status_alarm] = '${
            data_alarm[i].alarm_base
          }' AND [occurred_end] = '${moment(data_alarm[i].occurred_start).utc().format("YYYY-MM-DD HH:mm:ss.SSS")}'
          `
        );
      }
    }

    return {
      success: true,
      data_alarm,
    };
  } catch (error) {
    console.error("Database Query Error in sum alarm: ", error);
    return [];
  }
};

module.exports = sum_alarm;
