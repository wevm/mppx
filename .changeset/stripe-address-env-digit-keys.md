---
'mppx': patch
---

Fixed `mppx stripe address --env` to recognize multiline dotenv values under any key Node accepts, such as one starting with a digit or holding a space, and in files with CRLF line endings, so a line inside one is no longer taken for the deposit address. It also checks the result with Node's dotenv parser and refuses to write a file Node would read differently.
