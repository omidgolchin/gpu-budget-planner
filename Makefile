.PHONY: reproduce test

# Re-download both datasets and rebuild docs/data/prices.json (+ prices.js),
# results/data_summary.json and the spot-history figure.
reproduce:
	.venv/bin/python scripts/download_data.py
	PYTHONPATH=src .venv/bin/python scripts/process_data.py

test:
	PYTHONPATH=src .venv/bin/python -m pytest tests/ -q
