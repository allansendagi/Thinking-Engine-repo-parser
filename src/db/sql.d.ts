// `import schema from "./schema.sql" with { type: "text" }` -- Bun embeds the file as a string.
declare module "*.sql" {
  const text: string;
  export default text;
}
