# AfyaStock

AI early-warning and decision support for essential-medicine stockouts at health facilities.

AfyaStock forecasts which facilities will run out of which medicines in the next 30–60 days,
suggests redistribution of near-expiry stock, ranks reorders within a budget, and answers
questions in plain English or Swahili.

> Status: in active development. Prototype uses synthetic data only; no patient data.

## Structure
- `api/` – NestJS API and LLM assistant
- `ml/` – Python jobs: synthetic data, forecasting, optimisation
- `docs/` – model card and user guide
