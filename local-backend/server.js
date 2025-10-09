require("dotenv").config();
const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const cors = require("cors");

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());

// mms
app.use("/nat/tn/tn-realtime", require("./api_nat/tn_tn_realtime"));
app.use("/nat/gd/2ndinbore-realtime", require("./api_nat/gd_2ndInBore_realtime"));
app.use("/nat/gd/2ndinrace-realtime", require("./api_nat/gd_2ndInRace_realtime"));
app.use("/nat/gd/2ndinsuper-realtime", require("./api_nat/gd_2ndInSuper_realtime"));
app.use("/nat/gd/2ndoutsuper-realtime", require("./api_nat/gd_2ndOutSuper_realtime"));
app.use("/nat/gd/2ndoutrace-realtime", require("./api_nat/gd_2ndOutRace_realtime"));
app.use("/nat/assy/mbr-realtime", require("./api_nat/assy_mbr_realtime"));

app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});