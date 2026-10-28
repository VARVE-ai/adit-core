import { runDaemon } from "./daemon.js";
runDaemon(process.argv[2] ? Number(process.argv[2]) : undefined).catch(
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
