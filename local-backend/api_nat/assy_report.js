const express = require("express");
const router = express.Router();
const dbms = require("../instance/ms_instance_nat");

const queryMbrf = async (month) => {
  const mbrf = await dbms.query(`
DECLARE @Month date = '${month}-01';
DECLARE @cols nvarchar(max);
DECLARE @colsIsNull nvarchar(max);
DECLARE @sql nvarchar(max);
DECLARE @total nvarchar(max);
DECLARE @dayCount nvarchar(max);
DECLARE @avgExpr nvarchar(max);

;WITH Dates AS (
    SELECT CAST(@Month AS date) AS d
    UNION ALL
    SELECT DATEADD(DAY, 1, d)
    FROM Dates
    WHERE d < EOMONTH(@Month)
)
SELECT @cols = STRING_AGG(QUOTENAME(CONVERT(varchar(10), d, 23)), ',')
FROM Dates;

--check is data null?
SELECT @colsIsNull = STRING_AGG('ISNULL(' + col + ',0) AS ' + col, ',')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @total = STRING_AGG('ISNULL(' + col + ',0)', ' + ')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @dayCount = COUNT(*)
FROM STRING_SPLIT(@cols, ',');

SET @avgExpr = '(' + @total + ') / ' + CAST(@dayCount AS varchar(5));

SET @sql = '
WITH [base] AS (
    SELECT 
        [registered]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
            ELSE CONVERT(date, [registered])
        END AS [work_date]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 THEN ''N''
            ELSE ''M''
        END AS [shift]
        , UPPER([mc_no]) AS [mc_no]
        , [a_meas] as [total_gauge]
        , [a_ng_pos] as [or_ng_pos]
        , [a_ng_neg] as [or_ng_neg]
        , [b_ng_pos] as [ir_ng_pos]
        , [b_ng_neg] as [ir_ng_neg]
        , [a_unm] as [or_unmatch]
        , [b_unm] as [ir_unmatch]
        , [match] as [match_ok]
    FROM [nat_mc_assy_mbr_f].[dbo].[DATA_PRODUCTION_MBR_F]
    WHERE [registered] >= DATEADD(DAY,-1,@Month)
    AND [registered] < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, [registered]) IN (6,18)
),
[calc] AS (
    SELECT
        [work_date],
        [shift],
        [mc_no],
        CASE WHEN [shift] = ''M'' THEN [total_gauge]
			ELSE CASE WHEN [total_gauge] - LAG([total_gauge]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [total_gauge]
			ELSE [total_gauge] - LAG([total_gauge]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [total_gauge]
       , CASE WHEN [shift] = ''M'' THEN [or_ng_pos]
			ELSE CASE WHEN [or_ng_pos] - LAG([or_ng_pos]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [or_ng_pos]
			ELSE [or_ng_pos] - LAG([or_ng_pos]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [or_ng_pos]
		, CASE WHEN [shift] = ''M'' THEN [or_ng_neg]
			ELSE CASE WHEN [or_ng_neg] - LAG([or_ng_neg]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [or_ng_neg]
			ELSE [or_ng_neg] - LAG([or_ng_neg]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [or_ng_neg]
		, CASE WHEN [shift] = ''M'' THEN [ir_ng_pos]
			ELSE CASE WHEN [ir_ng_pos] - LAG([ir_ng_pos]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ir_ng_pos]
			ELSE [ir_ng_pos] - LAG([ir_ng_pos]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [ir_ng_pos]
		, CASE WHEN [shift] = ''M'' THEN [ir_ng_neg]
			ELSE CASE WHEN [ir_ng_neg] - LAG([ir_ng_neg]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ir_ng_neg]
			ELSE [ir_ng_neg] - LAG([ir_ng_neg]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [ir_ng_neg]
		, CASE WHEN [shift] = ''M'' THEN [or_unmatch]
			ELSE CASE WHEN [or_unmatch] - LAG([or_unmatch]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [or_unmatch]
			ELSE [or_unmatch] - LAG([or_unmatch]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [or_unmatch]
		, CASE WHEN [shift] = ''M'' THEN [ir_unmatch]
			ELSE CASE WHEN [ir_unmatch] - LAG([ir_unmatch]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ir_unmatch]
			ELSE [ir_unmatch] - LAG([ir_unmatch]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [ir_unmatch]
		, CASE WHEN [shift] = ''M'' THEN [match_ok]
			ELSE CASE WHEN [match_ok] - LAG([match_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [match_ok]
			ELSE [match_ok] - LAG([match_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [match_ok]
    FROM [base]
),
[unpivoted] AS (
    SELECT
        [mc_no],
        [shift],
        CONVERT(varchar(10), [work_date], 23) AS [work_date],
        [title],
        [value]
    FROM [calc]
    CROSS APPLY (
        VALUES
            (''Total Gauge'', [total_gauge])
			, (''Dia. NG O/R+'', [or_ng_pos])
			, (''Dia. NG O/R-'', [or_ng_neg])
			, (''Dia. NG I/R+'', [ir_ng_pos])
			, (''Dia. NG I/R-'', [ir_ng_neg])
			, (''Unmatch O/R'', [or_unmatch])
			, (''Unmatch I/R'', [ir_unmatch])
			, (''Match OK'', [match_ok])
    ) v([title], [value])
)
SELECT
    [mc_no],
    [shift],
    [title],
	' + @colsIsNull + ',
	' + @avgExpr + ' AS [avg],
    ' + @total + ' AS [total]
FROM [unpivoted]
PIVOT (
    MAX([value])
    FOR [work_date] IN (' + @cols + ')
) p
ORDER BY 
    [mc_no],
    [shift],
CASE title
    WHEN ''Total Gauge'' THEN 1
	WHEN ''Dia. NG O/R+'' THEN 2
	WHEN ''Dia. NG O/R-'' THEN 3
	WHEN ''Dia. NG I/R+'' THEN 4
	WHEN ''Dia. NG I/R-'' THEN 5
	WHEN ''Unmatch O/R'' THEN 6
	WHEN ''Unmatch I/R'' THEN 7
	WHEN ''Match OK'' THEN 8
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
    `);
  return mbrf[0].map((item) => {
    return {
      ...item,
      mc_no: item.mc_no.replace("_F", ""),
    };
  });
};

const queryMbr = async (month) => {
    const mbr = await dbms.query(`
DECLARE @Month date = '${month}-01';
DECLARE @cols nvarchar(max);
DECLARE @colsIsNull nvarchar(max);
DECLARE @sql nvarchar(max);
DECLARE @total nvarchar(max);
DECLARE @dayCount nvarchar(max);
DECLARE @avgExpr nvarchar(max);

;WITH Dates AS (
    SELECT CAST(@Month AS date) AS d
    UNION ALL
    SELECT DATEADD(DAY, 1, d)
    FROM Dates
    WHERE d < EOMONTH(@Month)
)
SELECT @cols = STRING_AGG(QUOTENAME(CONVERT(varchar(10), d, 23)), ',')
FROM Dates;

--check is data null?
SELECT @colsIsNull = STRING_AGG('ISNULL(' + col + ',0) AS ' + col, ',')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @total = STRING_AGG('ISNULL(' + col + ',0)', ' + ')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @dayCount = COUNT(*)
FROM STRING_SPLIT(@cols, ',');

SET @avgExpr = '(' + @total + ') / ' + CAST(@dayCount AS varchar(5));

SET @sql = '
WITH [base] AS (
    SELECT 
        [registered]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
            ELSE CONVERT(date, [registered])
        END AS [work_date]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 THEN ''N''
            ELSE ''M''
        END AS [shift]
        , UPPER([mc_no]) AS [mc_no]
        , ([c1_ng] + [c2_ng] + [c3_ng] + [c4_ng] + [c5_ng]) as [pallet_ng]
        , [daily_ok] as [retainer_ok]
        , ([ball_q] + [sep_ng_2]) as [turn_table_ng]
        , [d2_ng] as [retainer_ng]
    FROM [nat_mc_assy_mbr].[dbo].[DATA_PRODUCTION_MBR]
    WHERE [registered] >= DATEADD(DAY,-1,@Month)
    AND [registered] < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, [registered]) IN (6,18)
),
[calc] AS (
    SELECT
        [work_date],
        [shift],
        [mc_no],
        CASE WHEN [shift] = ''M'' THEN [pallet_ng]
            ELSE CASE WHEN [pallet_ng] - LAG([pallet_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [pallet_ng]
            ELSE [pallet_ng] - LAG([pallet_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [pallet_ng]
    , CASE WHEN [shift] = ''M'' THEN [retainer_ok]
            ELSE CASE WHEN [retainer_ok] - LAG([retainer_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [retainer_ok]
            ELSE [retainer_ok] - LAG([retainer_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [retainer_ok]
        , CASE WHEN [shift] = ''M'' THEN [turn_table_ng]
            ELSE CASE WHEN [turn_table_ng] - LAG([turn_table_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [turn_table_ng]
            ELSE [turn_table_ng] - LAG([turn_table_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [turn_table_ng]
        , CASE WHEN [shift] = ''M'' THEN [retainer_ng]
            ELSE CASE WHEN [retainer_ng] - LAG([retainer_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [retainer_ng]
            ELSE [retainer_ng] - LAG([retainer_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [retainer_ng]
    FROM [base]
),
[unpivoted] AS (
    SELECT
        [mc_no],
        [shift],
        CONVERT(varchar(10), [work_date], 23) AS [work_date],
        [title],
        [value]
    FROM [calc]
    CROSS APPLY (
        VALUES
            (''Ball NG (Pallet)'', [pallet_ng])
            , (''Retainer OK'', [retainer_ok])
            , (''Ball NG (Turn table)'', [turn_table_ng])
            , (''Retainer NG'', [retainer_ng])
    ) v([title], [value])
)
SELECT
    [mc_no],
    [shift],
    [title],
    ' + @colsIsNull + ',
    ' + @avgExpr + ' AS [avg],
    ' + @total + ' AS [total]
FROM [unpivoted]
PIVOT (
    MAX([value])
    FOR [work_date] IN (' + @cols + ')
) p
ORDER BY 
    [mc_no],
    [shift],
CASE title
    WHEN ''Ball NG (Pallet)'' THEN 1
    WHEN ''Retainer OK'' THEN 2
    WHEN ''Ball NG (Turn table)'' THEN 3
    WHEN ''Retainer NG'' THEN 4
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
    `);
  return mbr[0]
};

const queryArp = async (month) => {
  const arp = await dbms.query(`
DECLARE @Month date = '${month}-01';
DECLARE @cols nvarchar(max);
DECLARE @colsIsNull nvarchar(max);
DECLARE @sql nvarchar(max);
DECLARE @total nvarchar(max);
DECLARE @dayCount nvarchar(max);
DECLARE @avgExpr nvarchar(max);

;WITH Dates AS (
    SELECT CAST(@Month AS date) AS d
    UNION ALL
    SELECT DATEADD(DAY, 1, d)
    FROM Dates
    WHERE d < EOMONTH(@Month)
)
SELECT @cols = STRING_AGG(QUOTENAME(CONVERT(varchar(10), d, 23)), ',')
FROM Dates;

--check is data null?
SELECT @colsIsNull = STRING_AGG('ISNULL(' + col + ',0) AS ' + col, ',')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @total = STRING_AGG('ISNULL(' + col + ',0)', ' + ')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @dayCount = COUNT(*)
FROM STRING_SPLIT(@cols, ',');

SET @avgExpr = '(' + @total + ') / ' + CAST(@dayCount AS varchar(5));

SET @sql = '
WITH [base] AS (
    SELECT 
        [registered],
        CASE
            WHEN DATEPART(HOUR, [registered]) <= 6 
                THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
            ELSE CONVERT(date, [registered])
        END AS [work_date],
        CASE
            WHEN DATEPART(HOUR, [registered]) >= 19 OR DATEPART(HOUR, [registered]) < 7 THEN ''N''
            ELSE ''M''
        END AS [shift],
        UPPER([mc_no]) AS [mc_no],
        [daily_ok],
        [ng_pos],
        [ng_neg]
    FROM [nat_mc_assy_arp].[dbo].[DATA_PRODUCTION_ARP]
    WHERE [registered] >= DATEADD(DAY,-1,@Month)
    AND [registered] < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, [registered]) IN (6,18)
),
[calc] AS (
    SELECT
        [work_date],
        [shift],
        [mc_no],
        CASE WHEN [shift] = ''M'' THEN [daily_ok]
            ELSE CASE WHEN [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [daily_ok]
            ELSE [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [daily_ok],
        CASE WHEN [shift] = ''M'' THEN [ng_pos]
            ELSE CASE WHEN [ng_pos] - LAG([ng_pos]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ng_pos]
            ELSE [ng_pos] - LAG([ng_pos]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [ng_pos],
        CASE WHEN [shift] = ''M'' THEN [ng_neg]
            ELSE CASE WHEN [ng_neg] - LAG([ng_neg]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ng_neg]
            ELSE [ng_neg] - LAG([ng_neg]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [ng_neg]
    FROM [base]
),
[unpivoted] AS (
    SELECT
        [mc_no],
        [shift],
        CONVERT(varchar(10), [work_date], 23) AS [work_date],
        [title],
        [value]
    FROM [calc]
    CROSS APPLY (
        VALUES
            (''RP OK'', [daily_ok]),
            (''RP NG+'', [ng_pos]),
            (''RP NG-'', [ng_neg])
    ) v([title], [value])
)
SELECT
    [mc_no],
    [shift],
    [title],
    ' + @colsIsNull + ',
    ' + @avgExpr + ' AS [avg],
    ' + @total + ' AS [total]
FROM [unpivoted]
PIVOT (
    MAX([value])
    FOR [work_date] IN (' + @cols + ')
) p
ORDER BY 
    [mc_no],
    [shift],
CASE title
    WHEN ''RP OK'' THEN 1
    WHEN ''RP NG+''   THEN 2
    WHEN ''RP NG-''   THEN 3
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
    `);
  return arp[0]
};

const queryGssm = async (month) => {
  const gssm = await dbms.query(`
DECLARE @Month date = '${month}-01';
DECLARE @cols nvarchar(max);
DECLARE @colsIsNull nvarchar(max);
DECLARE @sql nvarchar(max);
DECLARE @total nvarchar(max);
DECLARE @dayCount nvarchar(max);
DECLARE @avgExpr nvarchar(max);

;WITH Dates AS (
    SELECT CAST(@Month AS date) AS d
    UNION ALL
    SELECT DATEADD(DAY, 1, d)
    FROM Dates
    WHERE d < EOMONTH(@Month)
)
SELECT @cols = STRING_AGG(QUOTENAME(CONVERT(varchar(10), d, 23)), ',')
FROM Dates;

--check is data null?
SELECT @colsIsNull = STRING_AGG('ISNULL(' + col + ',0) AS ' + col, ',')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @total = STRING_AGG('ISNULL(' + col + ',0)', ' + ')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @dayCount = COUNT(*)
FROM STRING_SPLIT(@cols, ',');

SET @avgExpr = '(' + @total + ') / ' + CAST(@dayCount AS varchar(5));

SET @sql = '
WITH [base] AS (
    SELECT 
        [registered]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
            ELSE CONVERT(date, [registered])
        END AS [work_date]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 THEN ''N''
            ELSE ''M''
        END AS [shift]
        , UPPER([mc_no]) AS [mc_no]
        , [grease_ok] as [total_grease]
        , [ro1_ng] as [ro1]
        , [ro2_ng] as [ro2]
        , [shield_ok] as [shield_ok]
        , [shield_a_ng] as [shield_a_ng]
        , [shield_b_ng] as [shield_b_ng]
        , [snap_a_ng] as [snap_a_ng]
        , [snap_b_ng] as [snap_b_ng]
    FROM [nat_mc_assy_gssm].[dbo].[DATA_PRODUCTION_GSSM]
    WHERE [registered] >= DATEADD(DAY,-1,@Month)
    AND [registered] < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, [registered]) IN (6,18)
),
[calc] AS (
    SELECT
        [work_date]
        , [shift]
        , [mc_no]
        ,CASE WHEN [shift] = ''M'' THEN [total_grease]
			ELSE CASE WHEN [total_grease] - LAG([total_grease]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [total_grease]
			ELSE [total_grease] - LAG([total_grease]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [total_grease]
       , CASE WHEN [shift] = ''M'' THEN [ro1]
			ELSE CASE WHEN [ro1] - LAG([ro1]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ro1]
			ELSE [ro1] - LAG([ro1]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [ro1]
		, CASE WHEN [shift] = ''M'' THEN [ro2]
			ELSE CASE WHEN [ro2] - LAG([ro2]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ro2]
			ELSE [ro2] - LAG([ro2]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [ro2]
		, CASE WHEN [shift] = ''M'' THEN [shield_ok]
			ELSE CASE WHEN [shield_ok] - LAG([shield_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [shield_ok]
			ELSE [shield_ok] - LAG([shield_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [shield_ok]
		, CASE WHEN [shift] = ''M'' THEN [shield_a_ng]
			ELSE CASE WHEN [shield_a_ng] - LAG([shield_a_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [shield_a_ng]
			ELSE [shield_a_ng] - LAG([shield_a_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [shield_a_ng]
		, CASE WHEN [shift] = ''M'' THEN [shield_b_ng]
			ELSE CASE WHEN [shield_b_ng] - LAG([shield_b_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [shield_b_ng]
			ELSE [shield_b_ng] - LAG([shield_b_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [shield_b_ng]
		, CASE WHEN [shift] = ''M'' THEN [snap_a_ng]
			ELSE CASE WHEN [snap_a_ng] - LAG([snap_a_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [snap_a_ng]
			ELSE [snap_a_ng] - LAG([snap_a_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [snap_a_ng]
		, CASE WHEN [shift] = ''M'' THEN [snap_b_ng]
			ELSE CASE WHEN [snap_b_ng] - LAG([snap_b_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [snap_b_ng]
			ELSE [snap_b_ng] - LAG([snap_b_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [snap_b_ng]
    FROM [base]
),
[unpivoted] AS (
    SELECT
        [mc_no]
        , [shift]
        , CONVERT(varchar(10), [work_date], 23) AS [work_date]
        , [title]
        , [value]
    FROM [calc]
    CROSS APPLY (
        VALUES
             (''Total Grease'', [total_grease])
			, (''RO1'', [ro1])
			, (''RO2'', [ro2])
			, (''Shield OK'', [shield_ok])
			, (''SH. A'', [shield_a_ng])
			, (''SH. B'', [shield_b_ng])
			, (''SN. A'', [snap_a_ng])
			, (''SN. B'', [snap_b_ng])
    ) v([title], [value])
)
SELECT
    [mc_no]
    , [shift]
    , [title]
	, ' + @colsIsNull + '
	, ' + @avgExpr + ' AS [avg]
    , ' + @total + ' AS [total]
FROM [unpivoted]
PIVOT (
    MAX([value])
    FOR [work_date] IN (' + @cols + ')
) p
ORDER BY 
    [mc_no],
    [shift],
CASE title
    WHEN ''Total Grease'' THEN 1
	WHEN ''RO1'' THEN 2
	WHEN ''RO2'' THEN 3
	WHEN ''Shield OK'' THEN 4
	WHEN ''SH. A'' THEN 5
	WHEN ''SH. B'' THEN 6
	WHEN ''SN. A'' THEN 7
	WHEN ''SN. B'' THEN 8
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
      `);
  return gssm[0]
};

const queryFim = async (month) => {
  const fim = await dbms.query(`
DECLARE @Month date = '${month}-01';
DECLARE @cols nvarchar(max);
DECLARE @colsIsNull nvarchar(max);
DECLARE @sql nvarchar(max);
DECLARE @total nvarchar(max);
DECLARE @dayCount nvarchar(max);
DECLARE @avgExpr nvarchar(max);

;WITH Dates AS (
    SELECT CAST(@Month AS date) AS d
    UNION ALL
    SELECT DATEADD(DAY, 1, d)
    FROM Dates
    WHERE d < EOMONTH(@Month)
)
SELECT @cols = STRING_AGG(QUOTENAME(CONVERT(varchar(10), d, 23)), ',')
FROM Dates;

--check is data null?
SELECT @colsIsNull = STRING_AGG('ISNULL(' + col + ',0) AS ' + col, ',')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @total = STRING_AGG('ISNULL(' + col + ',0)', ' + ')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @dayCount = COUNT(*)
FROM STRING_SPLIT(@cols, ',');

SET @avgExpr = '(' + @total + ') / ' + CAST(@dayCount AS varchar(5));

SET @sql = '
WITH [base] AS (
    SELECT 
        [registered]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
            ELSE CONVERT(date, [registered])
        END AS [work_date]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 THEN ''N''
            ELSE ''M''
        END AS [shift]
        , UPPER([mc_no]) AS [mc_no]
        , [fim_ok] as [fim_ok]
        , [id_ng] as [id_ng]
        , [od_ng] as [od_ng]
        , [width_ng] as [width_ng]
        , [chamfer_ng] as [chamfer_ng]
        , [mix_ng] as [mix_ng]
    FROM [nat_mc_assy_fim].[dbo].[DATA_PRODUCTION_FIM]
    WHERE [registered] >= DATEADD(DAY,-1,@Month)
    AND [registered] < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, [registered]) IN (6,18)
),
[calc] AS (
    SELECT
        [work_date]
        , [shift]
        , [mc_no]
        ,CASE WHEN [shift] = ''M'' THEN [fim_ok]
			ELSE CASE WHEN [fim_ok] - LAG([fim_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [fim_ok]
			ELSE [fim_ok] - LAG([fim_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [fim_ok]
       , CASE WHEN [shift] = ''M'' THEN [id_ng]
			ELSE CASE WHEN [id_ng] - LAG([id_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [id_ng]
			ELSE [id_ng] - LAG([id_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [id_ng]
		, CASE WHEN [shift] = ''M'' THEN [od_ng]
			ELSE CASE WHEN [od_ng] - LAG([od_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [od_ng]
			ELSE [od_ng] - LAG([od_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [od_ng]
		, CASE WHEN [shift] = ''M'' THEN [width_ng]
			ELSE CASE WHEN [width_ng] - LAG([width_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [width_ng]
			ELSE [width_ng] - LAG([width_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [width_ng]
		, CASE WHEN [shift] = ''M'' THEN [chamfer_ng]
			ELSE CASE WHEN [chamfer_ng] - LAG([chamfer_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [chamfer_ng]
			ELSE [chamfer_ng] - LAG([chamfer_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [chamfer_ng]
		, CASE WHEN [shift] = ''M'' THEN [mix_ng]
			ELSE CASE WHEN [mix_ng] - LAG([mix_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [mix_ng]
			ELSE [mix_ng] - LAG([mix_ng]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [mix_ng]
    FROM [base]
),
[unpivoted] AS (
    SELECT
        [mc_no]
        , [shift]
        , CONVERT(varchar(10), [work_date], 23) AS [work_date]
        , [title]
        , [value]
    FROM [calc]
    CROSS APPLY (
        VALUES
             (''FIM OK'', [fim_ok])
			, (''ID'', [id_ng])
			, (''OD'', [od_ng])
			, (''Width'', [width_ng])
			, (''C/F'', [chamfer_ng])
			, (''Mix NG'', [mix_ng])
    ) v([title], [value])
)
SELECT
    [mc_no]
    , [shift]
    , [title]
	, ' + @colsIsNull + '
	, ' + @avgExpr + ' AS [avg]
    , ' + @total + ' AS [total]
FROM [unpivoted]
PIVOT (
    MAX([value])
    FOR [work_date] IN (' + @cols + ')
) p
ORDER BY 
    [mc_no],
    [shift],
CASE title
    WHEN ''FIM OK'' THEN 1
	WHEN ''ID'' THEN 2
	WHEN ''OD'' THEN 3
	WHEN ''Width'' THEN 4
	WHEN ''C/F'' THEN 5
	WHEN ''Mix NG'' THEN 6
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
        `);
  return fim[0]
};

const queryAntF = async (month) => {
    const antf = await dbms.query(`
DECLARE @Month date = '${month}-01';
DECLARE @cols nvarchar(max);
DECLARE @colsIsNull nvarchar(max);
DECLARE @sql nvarchar(max);
DECLARE @total nvarchar(max);
DECLARE @dayCount nvarchar(max);
DECLARE @avgExpr nvarchar(max);

;WITH Dates AS (
    SELECT CAST(@Month AS date) AS d
    UNION ALL
    SELECT DATEADD(DAY, 1, d)
    FROM Dates
    WHERE d < EOMONTH(@Month)
)
SELECT @cols = STRING_AGG(QUOTENAME(CONVERT(varchar(10), d, 23)), ',')
FROM Dates;

--check is data null?
SELECT @colsIsNull = STRING_AGG('ISNULL(' + col + ',0) AS ' + col, ',')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @total = STRING_AGG('ISNULL(' + col + ',0)', ' + ')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @dayCount = COUNT(*)
FROM STRING_SPLIT(@cols, ',');

SET @avgExpr = '(' + @total + ') / ' + CAST(@dayCount AS varchar(5));

SET @sql = '
WITH [base] AS (
    SELECT 
        [registered],
        CASE
            WHEN DATEPART(HOUR, [registered]) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
            ELSE CONVERT(date, [registered])
        END AS [work_date],
        CASE
            WHEN DATEPART(HOUR, [registered]) = 6 THEN ''N''
            ELSE ''M''
        END AS [shift],
        UPPER([mc_no]) AS [mc_no],
        [ok_front],
        [ag_front],
        [ng_front],
        [mixball_front]
    FROM [nat_mc_assy_ant_new].[dbo].[DATA_PRODUCTION_ANT]
    WHERE [registered] >= DATEADD(DAY,-1,@Month)
    AND [registered] < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, [registered]) IN (6,18)
),
[calc] AS (
    SELECT
        [work_date],
        [shift],
        [mc_no],
        CASE WHEN [shift] = ''M'' THEN [ok_front]
            ELSE CASE WHEN [ok_front] - LAG([ok_front]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ok_front]
            ELSE [ok_front] - LAG([ok_front]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [ok_front],
        CASE WHEN [shift] = ''M'' THEN [ag_front]
            ELSE CASE WHEN [ag_front] - LAG([ag_front]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ag_front]
            ELSE [ag_front] - LAG([ag_front]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [ag_front],
        CASE WHEN [shift] = ''M'' THEN [ng_front]
            ELSE CASE WHEN [ng_front] - LAG([ng_front]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ng_front]
            ELSE [ng_front] - LAG([ng_front]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [ng_front],
        CASE WHEN [shift] = ''M'' THEN [mixball_front]
            ELSE CASE WHEN [mixball_front] - LAG([mixball_front]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [mixball_front]
            ELSE [mixball_front] - LAG([mixball_front]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [mixball_front]
    FROM [base]
),
[unpivoted] AS (
    SELECT
        [mc_no],
        [shift],
        CONVERT(varchar(10), [work_date], 23) AS [work_date],
        [title],
        [value]
    FROM [calc]
    CROSS APPLY (
        VALUES
            (''Noise OK'', [ok_front]),
            (''AG'', [ag_front]),
            (''NG'', [ng_front]),
            (''Mix Ball'', [mixball_front])
    ) v([title], [value])
)
SELECT
    [mc_no],
    [shift],
    [title],
    ' + @colsIsNull + ',
    ' + @avgExpr + ' AS [avg],
    ' + @total + ' AS [total]
FROM [unpivoted]
PIVOT (
    MAX([value])
    FOR [work_date] IN (' + @cols + ')
) p
ORDER BY 
    [mc_no],
    [shift],
CASE title
    WHEN ''Noise OK'' THEN 1
    WHEN ''AG''   THEN 2
    WHEN ''NG''   THEN 3
    WHEN ''Mix Ball''   THEN 4
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
    `);
    return antf[0].map((item) => {
        const mc = Number(item.mc_no.slice(-2))
        return {
            ...item,
            mc_no: item.mc_no.slice(0,3) + "0" + mc*2,
        };
    });
};

const queryAntR = async (month) => {
    const antr = await dbms.query(`
DECLARE @Month date = '${month}-01';
DECLARE @cols nvarchar(max);
DECLARE @colsIsNull nvarchar(max);
DECLARE @sql nvarchar(max);
DECLARE @total nvarchar(max);
DECLARE @dayCount nvarchar(max);
DECLARE @avgExpr nvarchar(max);

;WITH Dates AS (
    SELECT CAST(@Month AS date) AS d
    UNION ALL
    SELECT DATEADD(DAY, 1, d)
    FROM Dates
    WHERE d < EOMONTH(@Month)
)
SELECT @cols = STRING_AGG(QUOTENAME(CONVERT(varchar(10), d, 23)), ',')
FROM Dates;

--check is data null?
SELECT @colsIsNull = STRING_AGG('ISNULL(' + col + ',0) AS ' + col, ',')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @total = STRING_AGG('ISNULL(' + col + ',0)', ' + ')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @dayCount = COUNT(*)
FROM STRING_SPLIT(@cols, ',');

SET @avgExpr = '(' + @total + ') / ' + CAST(@dayCount AS varchar(5));


SET @sql = '
WITH [base] AS (
    SELECT 
        [registered],
        CASE
            WHEN DATEPART(HOUR, [registered]) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
            ELSE CONVERT(date, [registered])
        END AS [work_date],
        CASE
            WHEN DATEPART(HOUR, [registered]) = 6 THEN ''N''
            ELSE ''M''
        END AS [shift],
        UPPER([mc_no]) AS [mc_no],
        [ok_rear],
        [ag_rear],
        [ng_rear],
        [mixball_rear]
    FROM [nat_mc_assy_ant_new].[dbo].[DATA_PRODUCTION_ANT]
    WHERE [registered] >= DATEADD(DAY,-1,@Month)
    AND [registered] < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, [registered]) IN (6,18)
),
[calc] AS (
    SELECT
        [work_date],
        [shift],
        [mc_no],
        CASE WHEN [shift] = ''M'' THEN [ok_rear]
            ELSE CASE WHEN [ok_rear] - LAG([ok_rear]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ok_rear]
            ELSE [ok_rear] - LAG([ok_rear]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [ok_rear],
        CASE WHEN [shift] = ''M'' THEN [ag_rear]
            ELSE CASE WHEN [ag_rear] - LAG([ag_rear]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ag_rear]
            ELSE [ag_rear] - LAG([ag_rear]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [ag_rear],
        CASE WHEN [shift] = ''M'' THEN [ng_rear]
            ELSE CASE WHEN [ng_rear] - LAG([ng_rear]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [ng_rear]
            ELSE [ng_rear] - LAG([ng_rear]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [ng_rear],
        CASE WHEN [shift] = ''M'' THEN [mixball_rear]
            ELSE CASE WHEN [mixball_rear] - LAG([mixball_rear]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [mixball_rear]
            ELSE [mixball_rear] - LAG([mixball_rear]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
            END
        END AS [mixball_rear]
    FROM [base]
),
[unpivoted] AS (
    SELECT
        [mc_no],
        [shift],
        CONVERT(varchar(10), [work_date], 23) AS [work_date],
        [title],
        [value]
    FROM [calc]
    CROSS APPLY (
        VALUES
            (''Noise OK'', [ok_rear]),
            (''AG'', [ag_rear]),
            (''NG'', [ng_rear]),
            (''Mix Ball'', [mixball_rear])
    ) v([title], [value])
)
SELECT
    [mc_no],
    [shift],
    [title],
    ' + @colsIsNull + ',
    ' + @avgExpr + ' AS [avg],
    ' + @total + ' AS [total]
FROM [unpivoted]
PIVOT (
    MAX([value])
    FOR [work_date] IN (' + @cols + ')
) p
ORDER BY 
    [mc_no],
    [shift],
CASE title
    WHEN ''Noise OK'' THEN 1
    WHEN ''AG''   THEN 2
    WHEN ''NG''   THEN 3
    WHEN ''Mix Ball''   THEN 4
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
    `);
    return antr[0].map((item) => {
        const mc = Number(item.mc_no.slice(-2))
        const calc = mc+(mc-1)
        return {
            ...item,
            mc_no: item.mc_no.slice(0,3) + "0" + calc,
        };
    });
};

const queryAod = async (month) => {
    const aod = await dbms.query(`
DECLARE @Month date = '${month}-01';
DECLARE @cols nvarchar(max);
DECLARE @colsIsNull nvarchar(max);
DECLARE @sql nvarchar(max);
DECLARE @total nvarchar(max);
DECLARE @dayCount nvarchar(max);
DECLARE @avgExpr nvarchar(max);

;WITH Dates AS (
    SELECT CAST(@Month AS date) AS d
    UNION ALL
    SELECT DATEADD(DAY, 1, d)
    FROM Dates
    WHERE d < EOMONTH(@Month)
)
SELECT @cols = STRING_AGG(QUOTENAME(CONVERT(varchar(10), d, 23)), ',')
FROM Dates;

--check is data null?
SELECT @colsIsNull = STRING_AGG('ISNULL(' + col + ',0) AS ' + col, ',')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @total = STRING_AGG('ISNULL(' + col + ',0)', ' + ')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @dayCount = COUNT(*)
FROM STRING_SPLIT(@cols, ',');

SET @avgExpr = '(' + @total + ') / ' + CAST(@dayCount AS varchar(5));

SET @sql = '
WITH [base] AS (
    SELECT 
        [registered]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
            ELSE CONVERT(date, [registered])
        END AS [work_date]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 THEN ''N''
            ELSE ''M''
        END AS [shift]
        , UPPER([mc_no]) AS [mc_no]
        , [daily_ok] as [daily_ok]
        , [daily_ag] as [daily_ag]
    FROM [nat_mc_assy_aod].[dbo].[DATA_PRODUCTION_AOD]
    WHERE [registered] >= DATEADD(DAY,-1,@Month)
    AND [registered] < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, [registered]) IN (6,18)
),
[calc] AS (
    SELECT
        [work_date]
        , [shift]
        , [mc_no]
        ,CASE WHEN [shift] = ''M'' THEN [daily_ok]
			ELSE CASE WHEN [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [daily_ok]
			ELSE [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [daily_ok]
       , CASE WHEN [shift] = ''M'' THEN [daily_ag]
			ELSE CASE WHEN [daily_ag] - LAG([daily_ag]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [daily_ag]
			ELSE [daily_ag] - LAG([daily_ag]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [daily_ag]
    FROM [base]
),
[unpivoted] AS (
    SELECT
        [mc_no]
        , [shift]
        , CONVERT(varchar(10), [work_date], 23) AS [work_date]
        , [title]
        , [value]
    FROM [calc]
    CROSS APPLY (
        VALUES
             (''Auto OD OK'', [daily_ok])
			, (''AG'', [daily_ag])
    ) v([title], [value])
)
SELECT
    [mc_no]
    , [shift]
    , [title]
	, ' + @colsIsNull + '
	, ' + @avgExpr + ' AS [avg]
    , ' + @total + ' AS [total]
FROM [unpivoted]
PIVOT (
    MAX([value])
    FOR [work_date] IN (' + @cols + ')
) p
ORDER BY 
    [mc_no],
    [shift],
CASE title
    WHEN ''Auto OD OK'' THEN 1
	WHEN ''AG'' THEN 2
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
          `);
    return aod[0]
};

const queryAvs = async (month) => {
    const avs = await dbms.query(`
DECLARE @Month date = '${month}-01';
DECLARE @cols nvarchar(max);
DECLARE @colsIsNull nvarchar(max);
DECLARE @sql nvarchar(max);
DECLARE @total nvarchar(max);
DECLARE @dayCount nvarchar(max);
DECLARE @avgExpr nvarchar(max);

;WITH Dates AS (
    SELECT CAST(@Month AS date) AS d
    UNION ALL
    SELECT DATEADD(DAY, 1, d)
    FROM Dates
    WHERE d < EOMONTH(@Month)
)
SELECT @cols = STRING_AGG(QUOTENAME(CONVERT(varchar(10), d, 23)), ',')
FROM Dates;

--check is data null?
SELECT @colsIsNull = STRING_AGG('ISNULL(' + col + ',0) AS ' + col, ',')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @total = STRING_AGG('ISNULL(' + col + ',0)', ' + ')
FROM STRING_SPLIT(@cols, ',') split
CROSS APPLY (SELECT split.value AS col) x;

SELECT @dayCount = COUNT(*)
FROM STRING_SPLIT(@cols, ',');

SET @avgExpr = '(' + @total + ') / ' + CAST(@dayCount AS varchar(5));

SET @sql = '
WITH [base] AS (
    SELECT 
        [registered]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, [registered]))
            ELSE CONVERT(date, [registered])
        END AS [work_date]
        , CASE
            WHEN DATEPART(HOUR, [registered]) = 6 THEN ''N''
            ELSE ''M''
        END AS [shift]
        , UPPER([mc_no]) AS [mc_no]
        , [daily_ok] as [daily_ok]
        , [daily_ag1] as [daily_ag1]
		, [daily_ag2] as [daily_ag2]
    FROM [nat_mc_assy_avs].[dbo].[DATA_PRODUCTION_AVS]
    WHERE [registered] >= DATEADD(DAY,-1,@Month)
    AND [registered] < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, [registered]) IN (6,18)
),
[calc] AS (
    SELECT
        [work_date]
        , [shift]
        , [mc_no]
        ,CASE WHEN [shift] = ''M'' THEN [daily_ok]
			ELSE CASE WHEN [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [daily_ok]
			ELSE [daily_ok] - LAG([daily_ok]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [daily_ok]
       , CASE WHEN [shift] = ''M'' THEN [daily_ag1]
			ELSE CASE WHEN [daily_ag1] - LAG([daily_ag1]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [daily_ag1]
			ELSE [daily_ag1] - LAG([daily_ag1]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [daily_ag1]
		, CASE WHEN [shift] = ''M'' THEN [daily_ag2]
			ELSE CASE WHEN [daily_ag2] - LAG([daily_ag2]) OVER (PARTITION BY [mc_no] ORDER BY [registered]) < 0 THEN [daily_ag2]
			ELSE [daily_ag2] - LAG([daily_ag2]) OVER (PARTITION BY [mc_no] ORDER BY [registered])
			END
        END AS [daily_ag2]
    FROM [base]
),
[unpivoted] AS (
    SELECT
        [mc_no]
        , [shift]
        , CONVERT(varchar(10), [work_date], 23) AS [work_date]
        , [title]
        , [value]
    FROM [calc]
    CROSS APPLY (
        VALUES
             (''Auto Visual OK'', [daily_ok])
			, (''AG'', [daily_ag1])
			, (''NG'', [daily_ag2])
    ) v([title], [value])
)
SELECT
    [mc_no]
    , [shift]
    , [title]
	, ' + @colsIsNull + '
	, ' + @avgExpr + ' AS [avg]
    , ' + @total + ' AS [total]
FROM [unpivoted]
PIVOT (
    MAX([value])
    FOR [work_date] IN (' + @cols + ')
) p
ORDER BY 
    [mc_no],
    [shift],
CASE title
    WHEN ''Auto Visual OK'' THEN 1
	WHEN ''AG'' THEN 2
	WHEN ''NG'' THEN 3
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
    `);
    return avs[0]
};

router.post("/data", async (req, res) => {
  try {
    const {selectedMonth, selectedProcess} = req.body;
    console.log("Received month:", selectedMonth, "Received process:", selectedProcess);
    let mbrf = {};
    let mbr = {};
    let arp = {};
    let gssm = {};
    let fim = {};
    let antf = {};
    let antr = {};
    let aod = {};
    let avs = {};
    let mergedMbr = [];
    let mergedAnt = [];
    let data = [];
    switch (selectedProcess){
        case "mbr": 
            mbrf = await queryMbrf(selectedMonth);
            mbr = await queryMbr(selectedMonth);
            data.push([...mbrf, ...mbr]);
            break;
        case "arp":
            arp = await queryArp(selectedMonth);
            data.push(arp);
            break;
        case "gssm":
            gssm = await queryGssm(selectedMonth);
            data.push(gssm);
            break;
        case "fim":
            fim = await queryFim(selectedMonth);
            data.push(fim);
            break;
        case "ant": 
            antf = await queryAntF(selectedMonth);
            antr = await queryAntR(selectedMonth);
            data.push([...antf, ...antr]);
            break;
        case "aod":
            aod = await queryAod(selectedMonth);
            data.push(aod);
            break;
        case "avs":
            avs = await queryAvs(selectedMonth);
            data.push(avs);
            break;
        default:
            mbrf = await queryMbrf(selectedMonth);
            mbr = await queryMbr(selectedMonth);
            arp = await queryArp(selectedMonth);
            gssm = await queryGssm(selectedMonth);
            fim = await queryFim(selectedMonth);
            antf = await queryAntF(selectedMonth);
            antr = await queryAntR(selectedMonth);
            aod = await queryAod(selectedMonth);
            avs = await queryAvs(selectedMonth);
            mergedMbr = [...mbrf, ...mbr];
            mergedAnt = [...antf, ...antr];
            data = [mergedMbr, arp, gssm, fim, mergedAnt, aod, avs];
    }

    res.json({ success: true, data: data });
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;
