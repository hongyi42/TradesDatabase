---
name: spreadsheet
description: How to make a spreadsheet (.xlsx) for the manager from firm data — the house style and the helper script that applies it.
---

# Spreadsheets for the manager

Use this whenever the manager asks for a spreadsheet, an Excel file, an export or a list "as a file".

1. Get the data into a CSV with `export_query` (never by copying rows out of a tool result).
2. Turn the CSV into a styled workbook with the helper script on your computer:

   ```
   python3 /home/user/skills/spreadsheet/csv_to_xlsx.py /home/user/files/<name>.csv /home/user/files/<name>.xlsx --tz <firm timezone> --title "<Sheet title>"
   ```

   `--tz` is required: the firm's timezone, as the spine tools state it ("in the America/Los_Angeles
   timezone"). Times are shown in it, never in UTC.

   It applies the house style:
   - a bold header row, frozen so it stays visible while scrolling
   - column names turned into words ("customer_name" becomes "Customer Name")
   - money columns (a name ENDING in `cents`, `amount`, `balance`, `price`, `cost` or `total`) as
     numbers with a currency format; `*_cents` columns are divided by 100
   - dates as dates, and times converted to the firm's timezone
   - column widths fitted to the content
   - a short "Source" line under the table saying what the data is and when it was pulled
3. Look at the result before sending it (for example `python3 -c "import openpyxl; ..."` to count rows),
   then send it with `share_file` and a one-line caption.

Leave out ids (uuid columns) unless the manager asked for them: a person cannot use them.
If the manager wants a different layout, write your own openpyxl script; keep the house style.
