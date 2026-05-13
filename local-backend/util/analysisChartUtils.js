// local-backend/util/analysisChartUtils.js
const moment = require("moment-timezone");

const palette = [
  "#F59127","#ebaed3","#ffe119","#0082c8","#f58231","#911eb4","#46f0f0","#f032e6",
  "#d2f53c","#fabebe","#008080","#e6beff","#aa6e28","#fffac8","#800000","#aaffc3",
  "#808000","#ffd8b1","#000080","#808080","#FFFFFF","#000000","#9A6324","#469990",
  "#dcbeff","#4363d8","#bcf60c","#fabed4","#a9a9a9","#42d4f4","#f032e6","#bfef45",
  "#9c27b0","#ff9800","#795548","#03a9f4","#8bc34a","#ffc107","#607d8b","#673ab7",
  "#ff5722","#4caf50","#009688","#e91e63","#9e9e9e","#2196f3","#cddc39","#00bcd4",
  "#ffeb3b","#f44336","#d500f9","#69f0ae","#ffab40","#18ffff","#ff4081","#76ff03",
  "#40c4ff","#ff6e40","#ea80fc","#64ffda","#ffff00","#ff8a80","#c51162","#6200ea",
  "#2962ff","#00bfa5","#aeea00","#ffd600","#ff9100","#ff3d00","#b388ff","#8c9eff",
  "#80d8ff","#84ffff","#b9f6ca","#ccff90","#f4ff81","#ffe57f","#ffd180","#ff9e80",
  "#ef9a9a","#f48fb1","#ce93d8","#b39ddb","#9fa8da","#90caf9","#81d4fa","#80deea",
  "#80cbc4","#a5d6a7","#c5e1a5","#e6ee9c","#fff59d","#ffe082","#ffcc80","#ffab91",
  "#bcaaa4","#eeeeee","#b0bec5","#eb0cc5","#c2185b","#7b1fa2","#512da8","#303f9f",
  "#1976d2","#0288d1","#0097a7","#00796b","#388e3c","#689f38","#afb42b","#fbc02d",
  "#ffa000","#f57c00","#e64a19","#5d4037","#616161","#455a64","#d848c0","#6e2740",
  "#d500f9","#651fff","#3d5afe","#2979ff","#00b0ff","#00e5ff","#1de9b6","#00e676",
  "#76ff03","#c6ff00","#ffea00","#ffc400","#ff9100","#7b84da","#f44336","#e91e63",
  "#9c27b0","#673ab7","#3f51b5","#2196f3","#03a9f4","#00bcd4","#009688","#4caf50",
  "#8bc34a","#cddc39","#ffeb3b","#ffc107","#ff9800","#ff5722","#795548","#9e9e9e",
  "#607d8b","#263238","#f06292","#ba68c8","#9575cd","#7986cb","#64b5f6","#4fc3f7",
  "#4dd0e1","#4db6ac","#81c784","#aed581","#dce775","#fff176","#ffd54f","#ffb74d",
  "#ff8a65","#a1887f","#e0e0e0","#90a4ae","#a09828","#ad1457","#6a1b9a","#4527a0",
  "#485191","#1565c0","#0277bd","#00838f","#00695c","#2e7d32","#558b2f","#9e9d24",
  "#f9a825","#ff8f00","#ef6c00","#ee9b82","#4e342e","#424242","#37474f","#ff5252",
  "#ff4081","#e040fb","#7c4dff","#536dfe","#448aff","#40c4ff","#18ffff","#64ffda",
  "#69f0ae","#b2ff59","#eeff41","#ffff00","#ffd740","#ffab40","#ff6e40","#1e2020",
  "#df779d","#8e24aa","#5e35b1","#3949ab","#1e88e5","#039be5","#00acc1","#00897b",
  "#43a047","#7cb342","#c0ca33","#fdd835",
];

const calcTargetProd = (timeSeconds, row) => {
  if (row.target_special && row.target_special !== "") {
    return Number((row.target_special / 86400) * timeSeconds);
  }
  return (timeSeconds / row.target_ct) * (row.target_utl / 100) * (row.target_yield / 100) * row.ring_factor;
};

const generateData = (raw) => {
  const colorMap = {};
  const getColor = (status) => {
    const upperStatus = status.toUpperCase();
    if (upperStatus.includes("RUN")) return "#16C809";
    if (upperStatus.includes("STOP")) return "#F40B0B";
    if (!colorMap[status]) {
      colorMap[status] = palette[Object.keys(colorMap).length % palette.length];
    }
    return colorMap[status];
  };

  return raw.map((item) => {
    const start = moment(item.occurred_start).utc().format("YYYY-MM-DD HH:mm:ss");
    const end   = moment(item.occurred_end).utc().format("YYYY-MM-DD HH:mm:ss");
    const color = getColor(item.status_alarm);
    return {
      ...item,
      color,
      name: item.status_alarm,
      value: [0, start, end, item.duration_seconds, item.occurred_start, item.occurred_end],
      itemStyle: { color },
    };
  });
};

const summarize = (data) =>
  Object.values(
    data.reduce((acc, { status_alarm, duration_seconds, color }) => {
      if (!acc[status_alarm]) {
        acc[status_alarm] = { alarm: status_alarm, count: 0, duration: 0, color };
      }
      acc[status_alarm].count += 1;
      acc[status_alarm].duration += duration_seconds;
      return acc;
    }, {})
  ).map((item, index) => ({
    no: index + 1,
    color: item.color,
    alarm: item.alarm,
    count: item.count,
    duration: item.duration,
    time: new Date(item.duration * 1000).toISOString().substr(11, 8),
  }));

module.exports = { calcTargetProd, generateData, summarize };
