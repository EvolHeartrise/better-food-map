# Issue-#302 experiment fetch: all Overture "eatery" places in the Canada bbox
# with the fields needed to compare against the OSM staging store — category,
# confidence, operating_status, brand, address parts, contact presence, source
# datasets — plus a province assigned by point-in-polygon against
# data/canada-provinces.geojson (which doubles as the US-spillover filter).
# Inputs: data/overture_categories.csv (taxonomy CSV from the OvertureMaps/schema
# repo). Outputs: data/overture-canada-eateries.ndjson + data/overture-eateries.duckdb
# (file-backed so a failed post-processing step never re-costs the S3 scan).
# Compare against OSM with scripts/overture/compare-osm-eateries.ts.
import csv
import duckdb

RELEASE = "2026-06-17.0"
OUT = "data/overture-canada-eateries.ndjson"

# Eatery categories = the whole eat_and_drink subtree, plus the retail>food
# codes that mirror the OSM staging classes (bakery/pastry/confectionery/
# ice_cream and the food-truck/stand side of amenity=fast_food).
RETAIL_FOOD = {
    "bakery", "flatbread", "back_shop", "bagel_shop",
    "patisserie_cake_shop", "chimney_cake_shop", "cupcake_shop", "custom_cakes_shop",
    "desserts", "donuts", "pie_shop", "pretzels",
    "ice_cream_and_frozen_yoghurt", "gelato", "ice_cream_shop",
    "frozen_yoghurt_shop", "shaved_ice_shop", "shaved_snow_shop",
    "candy_store", "japanese_confectionery_shop", "chocolatier",
    "sandwich_shop", "food_stand", "food_truck", "friterie", "street_vendor",
}

cats = set()
with open(f"data/overture_categories.csv", encoding="utf-8-sig") as f:
    for row in csv.reader(f, delimiter=";"):
        if len(row) < 2 or row[0] == "Category code":
            continue
        code, path = row[0].strip(), row[1].strip().strip("[]").split(",")
        if path[0] == "eat_and_drink":
            cats.add(code)
        elif len(path) >= 2 and path[0] == "retail" and path[1] == "food" and code in RETAIL_FOOD:
            cats.add(code)
print(f"{len(cats)} eatery category codes")
cat_list = ", ".join(f"'{c}'" for c in sorted(cats))

con = duckdb.connect(f"data/overture-eateries.duckdb")
con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")
con.execute("SET s3_region='us-west-2';")

con.execute(f"""
CREATE TABLE IF NOT EXISTS eateries AS
SELECT id, names.primary AS name,
       categories.primary AS category,
       taxonomy.hierarchy AS hierarchy,
       confidence, operating_status,
       brand.wikidata AS brand_wikidata, brand.names.primary AS brand_name,
       ST_X(geometry) AS lon, ST_Y(geometry) AS lat,
       geometry,
       addresses[1].freeform AS freeform, addresses[1].locality AS locality,
       addresses[1].region AS addr_region, addresses[1].postcode AS postcode,
       addresses[1].country AS country,
       websites[1] AS website, phones[1] AS phone, socials[1] AS social,
       list_transform(sources, s -> s.dataset) AS datasets
FROM read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/*.parquet')
WHERE bbox.xmin BETWEEN -141.1 AND -52.5 AND bbox.ymin BETWEEN 41.6 AND 83.2
  AND categories.primary IN ({cat_list});
""")
n = con.execute("SELECT count(*) FROM eateries").fetchone()[0]
print(f"fetched {n} bbox eatery rows")

con.execute(f"""
CREATE OR REPLACE TABLE provinces AS
SELECT name AS province, ST_SetCRS(geom, 'OGC:CRS84') AS geom
FROM ST_Read('data/canada-provinces.geojson');
""")

con.execute(f"""
COPY (
  SELECT e.id, e.name, e.category, e.hierarchy, e.confidence, e.operating_status,
         e.brand_wikidata, e.brand_name, e.lon, e.lat,
         e.freeform, e.locality, e.addr_region, e.postcode, e.country,
         e.website, e.phone, e.social, e.datasets,
         p.province
  FROM eateries e
  LEFT JOIN provinces p ON ST_Contains(p.geom, e.geometry)
) TO '{OUT}' (FORMAT json);
""")
stats = con.execute("""
SELECT count(*) FILTER (p.province IS NOT NULL) AS in_canada,
       count(*) FILTER (p.province IS NULL) AS unassigned
FROM eateries e LEFT JOIN provinces p ON ST_Contains(p.geom, e.geometry)
""").fetchone()
print(f"wrote {OUT}: {stats[0]} PIP-assigned to a province, {stats[1]} unassigned (US spillover / offshore)")
