// A `.woff2` imported `with { type: "file" }` is the path the runtime serves it from: beside the source, or under
// `/$bunfs/` in a compiled binary.
declare module "*.woff2" {
  const path: string;
  export default path;
}
