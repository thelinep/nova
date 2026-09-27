"""Offline test of the event directory pipeline with small Overture/OSM/Google fixtures.
Run: python3 scripts/event-directory/test_event_directory.py  (needs duckdb; no network)."""
import gzip, json, os, sqlite3, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class EventDirectory(unittest.TestCase):
    def test_pipeline(self):
        import duckdb
        tmp = Path(tempfile.mkdtemp(prefix="event-dir-"))
        app, ov, out = tmp / "app", tmp / "ov", tmp / "out"
        (app / "data" / "event-planners").mkdir(parents=True)
        (ov / "theme=places" / "type=place").mkdir(parents=True)
        (ov / "theme=divisions" / "type=division_area").mkdir(parents=True)
        c = duckdb.connect()
        c.execute(f"""COPY (SELECT * FROM (VALUES
          ('o1', {{'primary':'Shree Banquet Hall'}}, {{'primary':'banquet_hall','alternate':['venue_and_event_space']}}, {{'xmin':73.85,'xmax':73.85,'ymin':18.52,'ymax':18.52}}, [{{'freeform':'FC Road','locality':'Pune','region':'MH','postcode':'411004','country':'IN'}}], ['+91 98220 11111'], 0.93),
          ('o2', {{'primary':'Royal Caterers'}}, {{'primary':'caterer','alternate':[]}}, {{'xmin':73.86,'xmax':73.86,'ymin':18.53,'ymax':18.53}}, [{{'freeform':NULL,'locality':'Pune','region':'MH','postcode':NULL,'country':'IN'}}], ['9822022222'], 0.8),
          ('o3', {{'primary':'City Hospital'}}, {{'primary':'hospital','alternate':[]}}, {{'xmin':73.87,'xmax':73.87,'ymin':18.54,'ymax':18.54}}, [{{'freeform':NULL,'locality':'Pune','region':'MH','postcode':NULL,'country':'IN'}}], [], 0.9),
          ('o4', {{'primary':'Sai Tent House'}}, {{'primary':'shopping','alternate':[]}}, {{'xmin':73.88,'xmax':73.88,'ymin':18.55,'ymax':18.55}}, [{{'freeform':NULL,'locality':'Pune','region':'MH','postcode':NULL,'country':'IN'}}], [], 0.6),
          ('o5', {{'primary':'Lahore Banquet'}}, {{'primary':'banquet_hall','alternate':[]}}, {{'xmin':74.3,'xmax':74.3,'ymin':31.5,'ymax':31.5}}, [{{'freeform':NULL,'locality':'Lahore','region':'PB','postcode':NULL,'country':'PK'}}], [], 0.9)
        ) t(id, names, categories, bbox, addresses, phones, confidence)) TO '{ov}/theme=places/type=place/p.parquet' (FORMAT parquet)""")
        c.execute(f"""COPY (SELECT * FROM (VALUES
          ('c1','country','IN',NULL,{{'primary':'India'}},{{'xmin':68.0,'ymin':6.5,'xmax':97.5,'ymax':37.2}}, NULL::BLOB),
          ('r1','region','IN','IN-MH',{{'primary':'Maharashtra'}},{{'xmin':72.6,'ymin':15.6,'xmax':80.9,'ymax':22.1}}, NULL::BLOB),
          ('d1','county','IN','IN-MH',{{'primary':'Pune'}},{{'xmin':73.3,'ymin':17.9,'xmax':75.2,'ymax':19.4}}, NULL::BLOB)
        ) t(id, subtype, country, region, names, bbox, geometry)) TO '{ov}/theme=divisions/type=division_area/d.parquet' (FORMAT parquet)""")
        (app / "data" / "event-planners" / "districts.json").write_text(json.dumps({"districts": [{"name": "Pune", "key": "MH:1", "state": "Maharashtra", "stateCode": "MH"}]}))
        db = sqlite3.connect(app / "data" / "event-planners" / "collection.db")
        db.executescript("""CREATE TABLE tasks (id TEXT, district TEXT, state TEXT); CREATE TABLE businesses (id TEXT, name TEXT, category TEXT, phone TEXT, website TEXT, address TEXT,
          rating TEXT, reviews TEXT, latitude REAL, longitude REAL, maps_url TEXT, first_seen TEXT, last_seen TEXT, raw_json TEXT); CREATE TABLE discoveries (task_id TEXT, business_id TEXT);
          INSERT INTO tasks VALUES ('MH:1','Pune','Maharashtra');
          INSERT INTO businesses VALUES ('g1','Shree Banquet Hall','Banquet hall','098220 11111',NULL,'FC Rd','4.3','(210)',18.5201,73.8502,'https://maps.google.com/?cid=1','t','t','{}');
          INSERT INTO discoveries VALUES ('MH:1','g1');""")
        db.commit(); db.close()
        env = {**os.environ, "EVENT_DIRECTORY_APP": str(app), "EVENT_DIRECTORY_DIR": str(out)}
        sys.path.insert(0, str(HERE))
        os.environ.update(env)
        import importlib, event_directory as ed
        importlib.reload(ed)
        (out / "raw").mkdir(parents=True)
        with gzip.open(out / "raw" / "osm-IN-IN-MH.ndjson.gz", "wt") as f:
            f.write(json.dumps(ed.osm_row({"type": "node", "id": 42, "lat": 18.521, "lon": 73.851, "tags": {"amenity": "marriage_hall", "name": "Shree Banquet Hall", "phone": "+91-9822011111"}}, "Maharashtra")) + "\n")
        for stage in (["overture", "--overture-source", str(ov)], ["google"], ["build"]):
            subprocess.run([sys.executable, str(HERE / "event_directory.py"), *stage], env=env, check=True, capture_output=True)
        con = sqlite3.connect(out / "directory.db")
        rows = {r[0]: r[1:] for r in con.execute("SELECT name, primary_category, district, sources, source_count, match_basis FROM places")}
        self.assertNotIn("City Hospital", rows)
        self.assertNotIn("Lahore Banquet", rows, "other countries are left out")
        self.assertEqual(rows["Shree Banquet Hall"], ("venue.banquet_hall", "Pune", "google,overture,osm", 3, "category"), "one place from three sources")
        self.assertEqual(rows["Sai Tent House"][0], "vendor.decor_tent"); self.assertEqual(rows["Sai Tent House"][4], "name")
        self.assertEqual(rows["Royal Caterers"][0], "vendor.caterer")
        gaps = json.loads((out / "gaps-IN.json").read_text())["gaps"]
        self.assertTrue(any(g["category"] == "vendor.florist" and g["have"] == 0 for g in gaps))
        self.assertFalse(any(g["category"] == "vendor.caterer" and g["have"] >= g["want"] for g in gaps))
        self.assertTrue((out / "event-directory-IN.csv").read_text().startswith("id,name,"))
        types = dict(con.execute("SELECT name, event_types FROM places"))
        self.assertEqual(types["Royal Caterers"], "ALL")
        cl = ed.parse_checklist(HERE.parent.parent / "docs" / "EVENT-PLANNING-CHECKLIST.md")
        self.assertEqual(len(cl["codes"]), 13)
        self.assertIn("WED", [c for s in cl["sections"] for it in s["items"] for c in it["codes"]])
        rep = subprocess.run([sys.executable, str(HERE / "event_directory.py"), "report", "--event", "WED"], env=env, check=True, capture_output=True, text=True).stdout
        self.assertIn("| Maharashtra | 3 |", rep)
        chk = subprocess.run([sys.executable, str(HERE / "event_directory.py"), "checklist", "--event", "WED"], env=env, check=True, capture_output=True, text=True).stdout
        self.assertIn("Florals & botanicals", chk); self.assertNotIn("Exhibition stands", chk)


if __name__ == "__main__":
    unittest.main()
