// 迁移期间保持原有导入地址。前后端都读取 shared/flow.mts 的同一份编译结果。
export * from "./generated/flow.mjs";
