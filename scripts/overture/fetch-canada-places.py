# One-off fetch of the full-Canada Overture Places address cache for
# `bun run overture:enrich` (see scripts/overture-enrich.ts header for the
# documented shape). Reads the public GeoParquet release straight from S3 and
# writes NDJSON with exactly the fields the enricher consumes. Lives in data/
# (gitignored) beside the cache it produces.
import duckdb

RELEASE = "2026-06-17.0"
OUT = "data/overture-canada-places.ndjson"

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")
con.execute("SET s3_region='us-west-2';")

con.execute(f"""
COPY (
  SELECT id, names.primary AS name,
         ST_X(geometry) AS lon, ST_Y(geometry) AS lat,
         addresses[1].freeform AS freeform, addresses[1].locality AS locality,
         addresses[1].region AS region, addresses[1].postcode AS postcode
  FROM read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/*.parquet')
  WHERE bbox.xmin BETWEEN -141.1 AND -52.5 AND bbox.ymin BETWEEN 41.6 AND 83.2
    AND addresses[1].freeform IS NOT NULL
) TO '{OUT}' (FORMAT json);
""")

n = sum(1 for _ in open(OUT))
print(f"wrote {n} places to {OUT} (release {RELEASE})")
