# cyclotomy@0.0.1 tree fixtures

These object bytes were generated with the published npm package
`cyclotomy@0.0.1`, then copied verbatim from its content-addressed store and
re-hashed independently.

- npm dist shasum: `a6b62a4ca006bdd9ad9d49a208a78dec22eacefc`
- npm integrity: `sha512-Mf5ETfsOl3gC4fGb+i7/J5SjBkaBJxzWWT1tWzX5xMkwk1AaBvs4u9A2Ba0LXrwCKTJ+lSkcoV+go3YpiJxh7A==`
- source `gitHead`: `1cc897c6f9ff30614393a2b6e88d8ef3739daf83`

`compatible.*` came from a normal v0.0.1 capture. The uppercase
`.GITIGNORE` fixture was generated on a case-sensitive filesystem with
`core.ignoreCase=false`; v0.0.1 correctly treated that name as an ordinary
managed file, while portable v2 deliberately cannot represent it without an
archived lowercase `.gitignore` policy source.

`incompatible-scope-prefix.*` came from a normal v0.0.1 capture whose Git
repository prefix contains 257 path components. Published v1 allowed it;
portable v2 deliberately caps workspace paths at 256 components.

Every object includes its original final LF. `expected.json` fixes byte lengths
and SHA-256 object ids so checkout or fixture drift fails loudly.
