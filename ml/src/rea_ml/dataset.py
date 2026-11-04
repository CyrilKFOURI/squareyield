"""Load the cleaned DVF sales and the context the model may use.

Only information that is known when someone looks at a property *today* is allowed as a
feature: its characteristics, its location, and public context (INSEE census). Nothing
computed from the sale's own price.
"""
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from .config import MARTS_DIR, SALES_PATH, Cleaning

SALE_COLUMNS = (
    "id_mutation", "date_mutation", "year", "half", "is_new_build", "price", "surface_m2", "price_m2",
    "property_type", "rooms", "surface_carrez_m2", "land_m2", "n_dependencies", "n_lots", "section",
    "code_commune", "code_departement", "longitude", "latitude", "location_precision",
)
SOCIO_COLUMNS = (
    "population", "population_growth_yearly", "vacancy_rate", "second_home_share", "renter_share",
    "median_living_standard", "jobs_growth_yearly",
)


def load_sales(cleaning: Cleaning, sales_path: Path = SALES_PATH) -> pd.DataFrame:
    """Residential single-dwelling sales that pass the sanity rules of `cleaning`."""
    c = cleaning
    query = f"""
        SELECT {", ".join(SALE_COLUMNS)}
        FROM '{sales_path.as_posix()}'
        WHERE price_m2 BETWEEN {c.min_price_m2} AND {c.max_price_m2}
          AND surface_m2 BETWEEN {c.min_surface_m2} AND {c.max_surface_m2}
          AND land_m2 <= {c.max_land_m2}
          AND coalesce(rooms, 0) <= {c.max_rooms}
          AND longitude IS NOT NULL
    """
    sales = duckdb.sql(query).df()
    sales["date_mutation"] = pd.to_datetime(sales["date_mutation"])
    sales["period"] = sales["year"].astype(str) + "-H" + sales["half"].astype(str)
    sales["log_price_m2"] = np.log(sales["price_m2"])
    return sales


def load_socio(marts_dir: Path = MARTS_DIR) -> pd.DataFrame:
    """INSEE context per commune (public, not derived from sale prices)."""
    return duckdb.sql(
        f"""SELECT geo_code AS code_commune, {", ".join(SOCIO_COLUMNS)}
            FROM '{(marts_dir / "kpi_socio.parquet").as_posix()}' WHERE geo_level = 'commune'"""
    ).df()


def split_by_time(sales: pd.DataFrame, train_until: str, valid_until: str) -> dict[str, pd.DataFrame]:
    dates = sales["date_mutation"]
    return {
        "train": sales[dates <= train_until].reset_index(drop=True),
        "valid": sales[(dates > train_until) & (dates <= valid_until)].reset_index(drop=True),
        "test": sales[dates > valid_until].reset_index(drop=True),
    }
