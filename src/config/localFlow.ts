export const IS_LOCAL_FLOW =
  import.meta.env?.VITE_LOCAL_FLOW === "1" ||
  (typeof process !== "undefined" && process.env.LOCAL_FLOW === "1");
