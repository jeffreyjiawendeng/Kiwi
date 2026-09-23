import { app } from "electron";
import { readFileSync } from "node:fs";

export const name: string = app.name;
export const config: string = readFileSync("config", "utf8");
