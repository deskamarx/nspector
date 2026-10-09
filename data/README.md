# Data folder

Put your CSV exports here. The app reads whatever it finds and ignores the rest.

The files it looks for:

| File | What it is | How to get it |
|---|---|---|
| `s4_imei_master.csv` | IMEI dispatch ledger, one row per unit | Google Sheets → File → Download → CSV |
| `s3_dispatch_sep.csv` | Dispatch register for a month | same |
| `s3_dispatch_oct.csv` | Dispatch register for a month | same |
| `s1_deposits.csv` | Deposit / money-in ledger | same |
| `s4_all.txt` | Returns and defect log | JSON with a `returns` key |
| `s4_orders.csv` | Order quantities | same |

Any file you add is kept. Any file missing is simply skipped, so you can start
with one sheet and add the others as you go.

## Your data stays yours

This folder is excluded from version control. Dealer names, payment amounts and
IMEIs are business data and are not published anywhere.

On first run the desktop app copies these files into its own working folder so
you can replace them without touching the installation:

```
Windows:  %APPDATA%\NSpector\data
macOS:    ~/Library/Application Support/NSpector/data
Linux:    ~/.config/NSpector/data
```

Replace the files there and press **Sync**. Every connected device updates.