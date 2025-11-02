require("dotenv").config();
const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const cors = require("cors");

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());

// NAT Routes
app.use("/nat/tn/tn-realtime", require("./api_nat/tn_tn_realtime").router);
app.use("/nat/tn/tn-sum-alarm", require("./api_nat/tn_tn_sum_alarm"));
app.use("/nat/tn/tn-history-daily", require("./api_nat/tn_history_daily"));
app.use("/nat/tn/tn-summary", require("./api_nat/tn_tn_summary"));

app.use("/nat/gd/2ndinbore-realtime", require("./api_nat/gd_2ndInBore_realtime").router);
app.use("/nat/gd/2ndinrace-realtime", require("./api_nat/gd_2ndInRace_realtime").router);
app.use("/nat/gd/2ndinsuper-realtime", require("./api_nat/gd_2ndInSuper_realtime").router);
app.use("/nat/gd/2ndoutsuper-realtime", require("./api_nat/gd_2ndOutSuper_realtime").router);
app.use("/nat/gd/2ndoutrace-realtime", require("./api_nat/gd_2ndOutRace_realtime").router);
app.use("/nat/gd/1gd-sum-alarm", require("./api_nat/gd_1gd_sum_alarm"));
app.use("/nat/gd/2gd-sum-alarm", require("./api_nat/gd_2gd_sum_alarm"));

app.use("/nat/assy/mbr-realtime", require("./api_nat/assy_mbr_realtime").router);
app.use("/nat/assy/mbr-sum-alarm", require("./api_nat/assy_mbr_sum_alarm"));
app.use("/nat/assy/arp-realtime", require("./api_nat/assy_arp_realtime").router);
app.use("/nat/assy/arp-sum-alarm", require("./api_nat/assy_arp_sum_alarm"));
app.use("/nat/assy/gssm-realtime", require("./api_nat/assy_gssm_realtime").router);
app.use("/nat/assy/gssm-sum-alarm", require("./api_nat/assy_gssm_sum_alarm"));
app.use("/nat/assy/fim-realtime", require("./api_nat/assy_fim_realtime").router);
app.use("/nat/assy/fim-sum-alarm", require("./api_nat/assy_fim_sum_alarm"));
app.use("/nat/assy/ant-realtime", require("./api_nat/assy_ant_realtime").router);
app.use("/nat/assy/ant-sum-alarm", require("./api_nat/assy_ant_sum_alarm"));
app.use("/nat/assy/aod-realtime", require("./api_nat/assy_aod_realtime").router);
app.use("/nat/assy/avs-realtime", require("./api_nat/assy_avs_realtime").router);
app.use("/nat/assy/avs-sum-alarm", require("./api_nat/assy_avs_sum_alarm"));
app.use("/nat/assy/alu-realtime", require("./api_nat/assy_alu_realtime").router);
app.use("/nat/assy/alu-sum-alarm", require("./api_nat/assy_alu_sum_alarm"));

app.use("/nat/assy/combine-realtime", require("./api_nat/assy_combine_realtime"));

app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});