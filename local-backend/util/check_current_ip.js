const os = require("os");

const networkInterfaces = os.networkInterfaces();

let currentIP = [];
for (let interfaceName in networkInterfaces) {
    let addresses = networkInterfaces[interfaceName].filter((item) => item.family === "IPv4");

    addresses.forEach((item) => {
        currentIP.push(item.address);
    })
}

module.exports = currentIP;
