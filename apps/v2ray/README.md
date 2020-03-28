# V2Ray

Parse settings from blinkload:

```bash
http get https://api.pay.pm/link/<token>\?mu\=2 \
  | base64 --decode \
  | cut -d '/' -f 3 \
  | while read line; do base64 --decode <<< $line; echo; echo; done
```
