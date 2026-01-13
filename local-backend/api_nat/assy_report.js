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
WITH base AS (
    SELECT 
        registered,
        CASE
            WHEN DATEPART(HOUR, registered) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, registered))
            ELSE CONVERT(date, registered)
        END AS work_date,
        CASE
            WHEN DATEPART(HOUR, registered) = 6 THEN ''N''
            ELSE ''M''
        END AS shift,
        mc_no
        , a_meas as total_gauge
        , a_ng_pos as or_ng_pos
        , a_ng_neg as or_ng_neg
        , b_ng_pos as ir_ng_pos
        , b_ng_neg as ir_ng_neg
        , a_unm as or_unmatch
        , b_unm as ir_unmatch
        , match as match_ok
    FROM [nat_mc_assy_mbr_f].[dbo].DATA_PRODUCTION_MBR_F
    WHERE registered >= DATEADD(DAY,-1,@Month)
    AND registered < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, registered) IN (6,18)
),
calc AS (
    SELECT
        work_date,
        shift,
        mc_no,
        CASE WHEN shift = ''M'' THEN total_gauge
			ELSE CASE WHEN total_gauge - LAG(total_gauge) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN total_gauge
			ELSE total_gauge - LAG(total_gauge) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS total_gauge
       , CASE WHEN shift = ''M'' THEN or_ng_pos
			ELSE CASE WHEN or_ng_pos - LAG(or_ng_pos) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN or_ng_pos
			ELSE or_ng_pos - LAG(or_ng_pos) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS or_ng_pos
		, CASE WHEN shift = ''M'' THEN or_ng_neg
			ELSE CASE WHEN or_ng_neg - LAG(or_ng_neg) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN or_ng_neg
			ELSE or_ng_neg - LAG(or_ng_neg) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS or_ng_neg
		, CASE WHEN shift = ''M'' THEN ir_ng_pos
			ELSE CASE WHEN ir_ng_pos - LAG(ir_ng_pos) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN ir_ng_pos
			ELSE ir_ng_pos - LAG(ir_ng_pos) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS ir_ng_pos
		, CASE WHEN shift = ''M'' THEN ir_ng_neg
			ELSE CASE WHEN ir_ng_neg - LAG(ir_ng_neg) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN ir_ng_neg
			ELSE ir_ng_neg - LAG(ir_ng_neg) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS ir_ng_neg
		, CASE WHEN shift = ''M'' THEN or_unmatch
			ELSE CASE WHEN or_unmatch - LAG(or_unmatch) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN or_unmatch
			ELSE or_unmatch - LAG(or_unmatch) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS or_unmatch
		, CASE WHEN shift = ''M'' THEN ir_unmatch
			ELSE CASE WHEN ir_unmatch - LAG(ir_unmatch) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN ir_unmatch
			ELSE ir_unmatch - LAG(ir_unmatch) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS ir_unmatch
		, CASE WHEN shift = ''M'' THEN match_ok
			ELSE CASE WHEN match_ok - LAG(match_ok) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN match_ok
			ELSE match_ok - LAG(match_ok) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS match_ok
    FROM base
),
unpivoted AS (
    SELECT
        mc_no,
        shift,
        CONVERT(varchar(10), work_date, 23) AS work_date,
        title,
        value
    FROM calc
    CROSS APPLY (
        VALUES
            (''Total Gauge'', total_gauge)
			, (''Dia. NG O/R+'', or_ng_pos)
			, (''Dia. NG O/R-'', or_ng_neg)
			, (''Dia. NG I/R+'', ir_ng_pos)
			, (''Dia. NG I/R-'', ir_ng_neg)
			, (''Unmatch O/R'', or_unmatch)
			, (''Unmatch I/R'', ir_unmatch)
			, (''Match OK'', match_ok)
    ) v(title, value)
)
SELECT
    mc_no,
    shift,
    title,
	' + @colsIsNull + ',
	' + @avgExpr + ' AS avg,
    ' + @total + ' AS total
FROM unpivoted
PIVOT (
    MAX(value)
    FOR work_date IN (' + @cols + ')
) p
ORDER BY 
mc_no,
shift,
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
      mc_no: item.mc_no.replace("_f", "").toUpperCase(),
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
    WITH base AS (
        SELECT 
            registered,
            CASE
                WHEN DATEPART(HOUR, registered) = 6 
                    THEN CONVERT(date, DATEADD(DAY, -1, registered))
                ELSE CONVERT(date, registered)
            END AS work_date,
            CASE
                WHEN DATEPART(HOUR, registered) = 6 THEN ''N''
                ELSE ''M''
            END AS shift,
            mc_no
            , (c1_ng+ c2_ng+ c3_ng+ c4_ng+ c5_ng) as pallet_ng
            , daily_ng as retainer_ok
            , (ball_q+sep_ng_2) as turn_table_ng
            , d2_ng as retainer_ng
        FROM [nat_mc_assy_mbr].[dbo].DATA_PRODUCTION_MBR
        WHERE registered >= DATEADD(DAY,-1,@Month)
        AND registered < DATEADD(DAY,2,EOMONTH(@Month))
        AND DATEPART(HOUR, registered) IN (6,18)
    ),
    calc AS (
        SELECT
            work_date,
            shift,
            mc_no,
            CASE WHEN shift = ''M'' THEN pallet_ng
                ELSE CASE WHEN pallet_ng - LAG(pallet_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN pallet_ng
                ELSE pallet_ng - LAG(pallet_ng) OVER (PARTITION BY mc_no ORDER BY registered)
                END
            END AS pallet_ng
        , CASE WHEN shift = ''M'' THEN retainer_ok
                ELSE CASE WHEN retainer_ok - LAG(retainer_ok) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN retainer_ok
                ELSE retainer_ok - LAG(retainer_ok) OVER (PARTITION BY mc_no ORDER BY registered)
                END
            END AS retainer_ok
            , CASE WHEN shift = ''M'' THEN turn_table_ng
                ELSE CASE WHEN turn_table_ng - LAG(turn_table_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN turn_table_ng
                ELSE turn_table_ng - LAG(turn_table_ng) OVER (PARTITION BY mc_no ORDER BY registered)
                END
            END AS turn_table_ng
            , CASE WHEN shift = ''M'' THEN retainer_ng
                ELSE CASE WHEN retainer_ng - LAG(retainer_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN retainer_ng
                ELSE retainer_ng - LAG(retainer_ng) OVER (PARTITION BY mc_no ORDER BY registered)
                END
            END AS retainer_ng
        FROM base
    ),
    unpivoted AS (
        SELECT
            mc_no,
            shift,
            CONVERT(varchar(10), work_date, 23) AS work_date,
            title,
            value
        FROM calc
        CROSS APPLY (
            VALUES
                (''Ball NG (Pallet)'', pallet_ng)
                , (''Retainer OK'', retainer_ok)
                , (''Ball NG (Turn table)'', turn_table_ng)
                , (''Retainer NG'', retainer_ng)
        ) v(title, value)
    )
    SELECT
        mc_no,
        shift,
        title,
        ' + @colsIsNull + ',
        ' + @avgExpr + ' AS avg,
        ' + @total + ' AS total
    FROM unpivoted
    PIVOT (
        MAX(value)
        FOR work_date IN (' + @cols + ')
    ) p
    ORDER BY 
    mc_no,
    shift,
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
  return mbr[0].map((item) => {
    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
    };
  });
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
    WITH base AS (
        SELECT 
            registered,
            CASE
                WHEN DATEPART(HOUR, registered) = 6 
                    THEN CONVERT(date, DATEADD(DAY, -1, registered))
                ELSE CONVERT(date, registered)
            END AS work_date,
            CASE
                WHEN DATEPART(HOUR, registered) = 6 THEN ''N''
                ELSE ''M''
            END AS shift,
            mc_no,
            daily_ok,
            ng_pos,
            ng_neg
        FROM nat_mc_assy_arp.dbo.DATA_PRODUCTION_ARP
        WHERE registered >= DATEADD(DAY,-1,@Month)
        AND registered < DATEADD(DAY,2,EOMONTH(@Month))
        AND DATEPART(HOUR, registered) IN (6,18)
    ),
    calc AS (
        SELECT
            work_date,
            shift,
            mc_no,
            CASE WHEN shift = ''M'' THEN daily_ok
                ELSE daily_ok - LAG(daily_ok) OVER (PARTITION BY mc_no ORDER BY registered)
            END AS daily_ok,
            CASE WHEN shift = ''M'' THEN ng_pos
                ELSE CASE WHEN ng_pos - LAG(ng_pos) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN ng_pos
                ELSE ng_pos - LAG(ng_pos) OVER (PARTITION BY mc_no ORDER BY registered)
                END
            END AS ng_pos,
            CASE WHEN shift = ''M'' THEN ng_neg
                ELSE CASE WHEN ng_neg - LAG(ng_neg) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN ng_neg
                ELSE ng_neg - LAG(ng_neg) OVER (PARTITION BY mc_no ORDER BY registered)
                END
            END AS ng_neg
        FROM base
    ),
    unpivoted AS (
        SELECT
            mc_no,
            shift,
            CONVERT(varchar(10), work_date, 23) AS work_date,
            title,
            value
        FROM calc
        CROSS APPLY (
            VALUES
                (''RP OK'', daily_ok),
                (''RP NG+'', ng_pos),
                (''RP NG-'', ng_neg)
        ) v(title, value)
    )
    SELECT
        mc_no,
        shift,
        title,
        ' + @colsIsNull + ',
        ' + @avgExpr + ' AS avg,
        ' + @total + ' AS total
    FROM unpivoted
    PIVOT (
        MAX(value)
        FOR work_date IN (' + @cols + ')
    ) p
    ORDER BY 
    mc_no,
    shift,
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
  return arp[0].map((item) => {
    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
    };
  });
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
WITH base AS (
    SELECT 
        prod.registered,
        CASE
            WHEN DATEPART(HOUR, prod.registered) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, prod.registered))
            ELSE CONVERT(date, prod.registered)
        END AS work_date,
        CASE
            WHEN DATEPART(HOUR, prod.registered) = 6 THEN ''N''
            ELSE ''M''
        END AS shift,
        prod.mc_no
		, target_ct
        , grease_ok as total_grease
        , ro1_ng as ro1
        , ro2_ng as ro2
        , shield_ok as shield_ok
        , shield_a_ng as shield_a_ng
        , shield_b_ng as shield_b_ng
        , snap_a_ng as snap_a_ng
        , snap_b_ng as snap_b_ng
    FROM [nat_mc_assy_gssm].[dbo].DATA_PRODUCTION_GSSM prod
	LEFT JOIN [nat_mc_assy_gssm].[dbo].[DATA_MASTER_GSSM] masterdata ON prod.mc_no = masterdata.mc_no
    WHERE prod.registered >= DATEADD(DAY,-1,@Month)
    AND prod.registered < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, prod.registered) IN (6,18)
),
calc AS (
    SELECT
        work_date
        , shift
        , mc_no
		, target_ct
        ,CASE WHEN shift = ''M'' THEN total_grease
			ELSE CASE WHEN total_grease - LAG(total_grease) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN total_grease
			ELSE total_grease - LAG(total_grease) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS total_grease
       , CASE WHEN shift = ''M'' THEN ro1
			ELSE CASE WHEN ro1 - LAG(ro1) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN ro1
			ELSE ro1 - LAG(ro1) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS ro1
		, CASE WHEN shift = ''M'' THEN ro2
			ELSE CASE WHEN ro2 - LAG(ro2) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN ro2
			ELSE ro2 - LAG(ro2) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS ro2
		, CASE WHEN shift = ''M'' THEN shield_ok
			ELSE CASE WHEN shield_ok - LAG(shield_ok) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN shield_ok
			ELSE shield_ok - LAG(shield_ok) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS shield_ok
		, CASE WHEN shift = ''M'' THEN shield_a_ng
			ELSE CASE WHEN shield_a_ng - LAG(shield_a_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN shield_a_ng
			ELSE shield_a_ng - LAG(shield_a_ng) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS shield_a_ng
		, CASE WHEN shift = ''M'' THEN shield_b_ng
			ELSE CASE WHEN shield_b_ng - LAG(shield_b_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN shield_b_ng
			ELSE shield_b_ng - LAG(shield_b_ng) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS shield_b_ng
		, CASE WHEN shift = ''M'' THEN snap_a_ng
			ELSE CASE WHEN snap_a_ng - LAG(snap_a_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN snap_a_ng
			ELSE snap_a_ng - LAG(snap_a_ng) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS snap_a_ng
		, CASE WHEN shift = ''M'' THEN snap_b_ng
			ELSE CASE WHEN snap_b_ng - LAG(snap_b_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN snap_b_ng
			ELSE snap_b_ng - LAG(snap_b_ng) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS snap_b_ng
    FROM base
),
unpivoted AS (
    SELECT
        mc_no
		, target_ct
        , shift
        , CONVERT(varchar(10), work_date, 23) AS work_date
        , title
        , value
    FROM calc
    CROSS APPLY (
        VALUES
			(''Cycle time'', target_ct)
            , (''Total Grease'', total_grease)
			, (''RO1'', ro1)
			, (''RO2'', ro2)
			, (''Shield OK'', shield_ok)
			, (''SH. A'', shield_a_ng)
			, (''SH. B'', shield_b_ng)
			, (''SN. A'', snap_a_ng)
			, (''SN. B'', snap_b_ng)
    ) v(title, value)
)
SELECT
    mc_no
    , shift
    , title
	, ' + @colsIsNull + '
	, ' + @avgExpr + ' AS avg
    , ' + @total + ' AS total
FROM unpivoted
PIVOT (
    MAX(value)
    FOR work_date IN (' + @cols + ')
) p
ORDER BY 
mc_no,
shift,
CASE title
	WHEN ''Cycle time'' THEN 1
    WHEN ''Total Grease'' THEN 2
	WHEN ''RO1'' THEN 3
	WHEN ''RO2'' THEN 4
	WHEN ''Shield OK'' THEN 5
	WHEN ''SH. A'' THEN 6
	WHEN ''SH. B'' THEN 7
	WHEN ''SN. A'' THEN 8
	WHEN ''SN. B'' THEN 9
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
      `);
  return gssm[0].map((item) => {
    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
    };
  });
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
WITH base AS (
    SELECT 
        prod.registered,
        CASE
            WHEN DATEPART(HOUR, prod.registered) = 6 
                THEN CONVERT(date, DATEADD(DAY, -1, prod.registered))
            ELSE CONVERT(date, prod.registered)
        END AS work_date,
        CASE
            WHEN DATEPART(HOUR, prod.registered) = 6 THEN ''N''
            ELSE ''M''
        END AS shift,
        prod.mc_no
		, target_ct
        , fim_ok as fim_ok
        , id_ng as id_ng
        , od_ng as od_ng
        , width_ng as width_ng
        , chamfer_ng as chamfer_ng
        , mix_ng as mix_ng
    FROM [nat_mc_assy_fim].[dbo].DATA_PRODUCTION_FIM prod
	LEFT JOIN [nat_mc_assy_fim].[dbo].[DATA_MASTER_FIM] masterdata ON prod.mc_no = masterdata.mc_no
    WHERE prod.registered >= DATEADD(DAY,-1,@Month)
    AND prod.registered < DATEADD(DAY,2,EOMONTH(@Month))
    AND DATEPART(HOUR, prod.registered) IN (6,18)
),
calc AS (
    SELECT
        work_date
        , shift
        , mc_no
		, target_ct
        ,CASE WHEN shift = ''M'' THEN fim_ok
			ELSE CASE WHEN fim_ok - LAG(fim_ok) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN fim_ok
			ELSE fim_ok - LAG(fim_ok) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS fim_ok
       , CASE WHEN shift = ''M'' THEN id_ng
			ELSE CASE WHEN id_ng - LAG(id_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN id_ng
			ELSE id_ng - LAG(id_ng) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS id_ng
		, CASE WHEN shift = ''M'' THEN od_ng
			ELSE CASE WHEN od_ng - LAG(od_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN od_ng
			ELSE od_ng - LAG(od_ng) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS od_ng
		, CASE WHEN shift = ''M'' THEN width_ng
			ELSE CASE WHEN width_ng - LAG(width_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN width_ng
			ELSE width_ng - LAG(width_ng) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS width_ng
		, CASE WHEN shift = ''M'' THEN chamfer_ng
			ELSE CASE WHEN chamfer_ng - LAG(chamfer_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN chamfer_ng
			ELSE chamfer_ng - LAG(chamfer_ng) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS chamfer_ng
		, CASE WHEN shift = ''M'' THEN mix_ng
			ELSE CASE WHEN mix_ng - LAG(mix_ng) OVER (PARTITION BY mc_no ORDER BY registered) < 0 THEN mix_ng
			ELSE mix_ng - LAG(mix_ng) OVER (PARTITION BY mc_no ORDER BY registered)
			END
        END AS mix_ng
    FROM base
),
unpivoted AS (
    SELECT
        mc_no
		, target_ct
        , shift
        , CONVERT(varchar(10), work_date, 23) AS work_date
        , title
        , value
    FROM calc
    CROSS APPLY (
        VALUES
			(''Cycle time'', target_ct)
            , (''FIM OK'', fim_ok)
			, (''ID'', id_ng)
			, (''OD'', od_ng)
			, (''Width'', width_ng)
			, (''C/F'', chamfer_ng)
			, (''Mix NG'', mix_ng)
    ) v(title, value)
)
SELECT
    mc_no
    , shift
    , title
	, ' + @colsIsNull + '
	, ' + @avgExpr + ' AS avg
    , ' + @total + ' AS total
FROM unpivoted
PIVOT (
    MAX(value)
    FOR work_date IN (' + @cols + ')
) p
ORDER BY 
mc_no,
shift,
CASE title
	WHEN ''Cycle time'' THEN 1
    WHEN ''FIM OK'' THEN 2
	WHEN ''ID'' THEN 3
	WHEN ''OD'' THEN 4
	WHEN ''Width'' THEN 5
	WHEN ''C/F'' THEN 6
	WHEN ''Mix NG'' THEN 7
    ELSE 99
END;
';

EXEC sp_executesql 
    @sql,
    N'@Month date',
    @Month = @Month;
        `);
  return fim[0].map((item) => {
    return {
      ...item,
      mc_no: item.mc_no.toUpperCase(),
    };
  });
};

router.post("/data", async (req, res) => {
  try {
    const selectedMonth = req.body.selectedMonth;
    // console.log("Received month:", selectedMonth);
    const mbrf = await queryMbrf(selectedMonth);
    const mbr = await queryMbr(selectedMonth);
    const arp = await queryArp(selectedMonth);
    const gssm = await queryGssm(selectedMonth);
    const fim = await queryFim(selectedMonth);
    const mergedMbr = [...mbrf, ...mbr];

    res.json({ success: true, data: [mergedMbr, arp, gssm, fim] });
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;
