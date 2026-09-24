import sys
from pypdf import PdfReader, PdfWriter

pages_to_remove = {1, 2, 4, 74, 75}

reader = PdfReader(sys.argv[1])
writer = PdfWriter()

for i, page in enumerate(reader.pages, start=1):
    if i not in pages_to_remove:
        writer.add_page(page)

with open(sys.argv[1], "wb") as f:
    writer.write(f)
