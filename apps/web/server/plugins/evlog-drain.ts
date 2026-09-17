import { createFsDrain } from "evlog/fs";

export default defineNitroPlugin((nitroApp) => {
  if (!import.meta.dev) return;
  nitroApp.hooks.hook("evlog:drain", createFsDrain());
});
