# Cyfouri

Analyse de l'investissement locatif en France, commune par commune, à partir des données publiques
(ventes signées DVF, loyers ANIL, INSEE, DPE). Un pipeline hors ligne précalcule tous les indicateurs ;
l'application web et mobile ne fait que les lire.

- **Carte** : départements et communes du vert (bon marché) au rouge (cher), points par commune et par
  section cadastrale, survol avec les chiffres clés.
- **Explorer** : toutes les communes d'un département, triables sur chaque indicateur, filtres budget /
  rendement / cash-flow / population / vacance / DPE, nuage prix × rentabilité, export CSV.
- **Évolution** : courbes de prix de six lieux, base 100, ventes, loyers en place (OLL).
- **Marché** : la page complète d'une ville : prix par taille, loyers, rentabilité d'un bien type,
  demande, parc, DPE et calendrier d'interdiction de louer, fiscalité, score, territoire, voisins.
- **Analyser un bien** : une annonce face à son marché : estimation par un modèle de prix, ventes
  comparables, loyer à sa surface, cash-flow, risques. L'extension navigateur pré-remplit le formulaire.
- **Simulateur** : crédit, fiscalité (micro-foncier, réel, LMNP), revente et TRI, BRRRR, sensibilité.

**Site : https://cyrilkfouri.github.io/real-estate-analytics-fr/**

Tout compare des biens comparables : même type, même taille, ancien ou neuf, même période.

## Structure
| Dossier | Contenu |
|---|---|
| `pipeline/` | Python 3.12, uv, DuckDB : téléchargement, nettoyage, indicateurs, contrôles, publication JSON |
| `ml/` | modèle de prix (LightGBM, intervalles, explications) et API locale d'estimation |
| `apps/app/` | Expo SDK 58 : site web et application iOS / Android (mêmes écrans) |
| `apps/extension/` | extension navigateur (Manifest V3) |
| `docs/` | spécifications, indicateurs (`KPI_SPEC.md`), exécution du pipeline, design |

## Démarrer
```bash
cd pipeline && uv run rea build          # télécharge les sources et calcule les indicateurs (~1 h)
uv run rea sync-app                      # copie les fichiers publiés dans l'application
cd ../apps/app && npm install && npx expo start --web
```
Estimation de prix d'un bien (optionnel) :
```bash
cd ml && uv run rea-ml train             # entraîne le modèle (data/models/)
uv run rea-ml serve                      # API locale sur http://localhost:8787
```
Le modèle publié est aussi sur Hugging Face (`rea-price-check-fr`).

## Tests
```bash
cd pipeline && uv run pytest -q
cd ml && uv run pytest -q
cd apps/app && npm test && npx tsc --noEmit && npx expo lint
cd apps/extension && node --test "test/*.test.js"
```

## Données et conditions d'usage
| Source | Producteur | Licence |
|---|---|---|
| Demandes de valeurs foncières (DVF) | DGFiP | Licence Ouverte / Etalab 2.0 |
| Carte des loyers | ANIL | Licence Ouverte / Etalab 2.0 |
| Recensement, revenus, emploi | INSEE | Licence Ouverte / Etalab 2.0 |
| DPE des logements | ADEME | Licence Ouverte / Etalab 2.0 |
| Taux de taxe foncière (REI) | DGFiP | Licence Ouverte / Etalab 2.0 |
| Loyers en place | Observatoires locaux des loyers (OLL) | conditions des observatoires |

Conditions DVF respectées : aucune vente individuelle n'est publiée (un chiffre exige au moins 10 ventes),
aucune réidentification, aucune indexation par les moteurs de recherche (`robots.txt`, `noindex`). Les ventes
comparables ne sont visibles que sur l'API locale, jamais en ligne. Pas de données en Alsace-Moselle et à
Mayotte (hors DVF).

Les chiffres sont des indicateurs de marché, pas un conseil en investissement.

## Licence
Code et modèle : MIT (voir `LICENSE`). Les données gardent la licence de leur producteur.
