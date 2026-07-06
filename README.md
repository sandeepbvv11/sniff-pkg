# sniff-pkg

Check an npm package for red flags **before you install it**.

Zero dependencies — uses only Node built-ins and the public npm registry.

## What it checks

1. **Freshness** — was this version published very recently? (most malicious releases get pulled within days)
2. **Install scripts** — does it run code on install (`preinstall`/`install`/`postinstall`), and is that script new or changed vs. the previous version?
3. **Typosquatting** — is the name suspiciously close to one of ~17,000 popular packages? (list auto-downloaded from the npm registry, cached locally for 7 days)
4. **Maintainer churn** — did the maintainer list change in the latest release?
5. **Basic hygiene** — deprecated, no repo link, tiny track record.

## Usage

```
node index.js <package-name>[@version]   check one package
node index.js --project [path]           check all deps in every package.json under path


Exit codes: `0` clean/warnings only, `1` at least one DANGER finding, `2` usage error / path not found.

## Development
npm test
```

