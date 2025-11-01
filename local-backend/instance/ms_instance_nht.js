const Sequelize = require("sequelize");

const dbms = new Sequelize({
    dialect: 'mssql',
    host: process.env.NHT_SERVER,
    username: process.env.NHT_SERVER_USERNAME,
    password: process.env.NHT_SERVER_PASSWORD,
    dialectOptions: {
        options: {
            requestTimeout: 60000,
            instanceName: "",
        }
    }
});

(async () => {
    try {
        await dbms.authenticate();
        console.log("Database connection has been established successfully.");
    } catch (error) {
        console.error("Unable to connect to the database:", error);
    }
})();

module.exports = dbms;
