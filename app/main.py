from pathlib import Path
import csv, hashlib, hmac, os, secrets, time
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Query, HTTPException, Request, Depends
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, String, Text, Float, Boolean, select, or_, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker, Session
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

ROOT = Path(__file__).resolve().parent.parent
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{(ROOT / 'data' / 'medsetu.db').as_posix()}")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)

class Base(DeclarativeBase):
    pass

class LegacyMedicine(Base):
    __tablename__ = "medicines"
    id: Mapped[int] = mapped_column(primary_key=True)
    search_terms: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    composition: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    strength: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    form: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    manufacturer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    brand_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    generic_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    generic_composition: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    generic_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    verdict: Mapped[str] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text)
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(Text)

class CatalogueMedicine(Base):
    __tablename__ = "catalogue_medicines"
    medicine_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    display_name: Mapped[str] = mapped_column(Text)
    generic_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    composition: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    strength: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    dosage_form: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    route: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    manufacturer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    demo_price_inr: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    demo_match_group: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    data_status: Mapped[str] = mapped_column(String(40), default="DEMO_ONLY")

class Kendra(Base):
    __tablename__ = "kendras"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    address: Mapped[str] = mapped_column(Text)
    pincode: Mapped[Optional[str]] = mapped_column(String(12), nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)

engine_kwargs = {"pool_pre_ping": True}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}
engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    if DATABASE_URL.startswith("sqlite"):
        (ROOT / "data").mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if db.scalar(select(func.count()).select_from(CatalogueMedicine)) == 0:
            csv_file = ROOT / "data" / "medsetu_demo_medicine_catalogue.csv"
            if csv_file.exists():
                with csv_file.open("r", encoding="utf-8-sig", newline="") as f:
                    for item in csv.DictReader(f):
                        db.add(CatalogueMedicine(
                            medicine_id=item["medicine_id"], display_name=item["display_name"],
                            generic_name=item.get("generic_name"), composition=item.get("composition"),
                            strength=item.get("strength"), dosage_form=item.get("dosage_form"),
                            route=item.get("route"), manufacturer=item.get("manufacturer"),
                            demo_price_inr=float(item["demo_price_inr"]) if item.get("demo_price_inr") else None,
                            demo_match_group=item.get("demo_match_group"), data_status=item.get("data_status") or "DEMO_ONLY"))
        if db.scalar(select(func.count()).select_from(LegacyMedicine)) == 0:
            db.add(LegacyMedicine(search_terms="dolo 650|paracetamol 650|crocin 650|paracetamol", name="Paracetamol 650 mg (illustrative entry)", composition="Paracetamol 650 mg", strength="650 mg", form="Tablet", manufacturer="Not verified", brand_price=30, generic_name="Paracetamol 650 mg (sample catalogue entry)", generic_composition="Paracetamol 650 mg", generic_price=10, verdict="ask_doctor", reason="Illustrative catalogue data only. Confirm the exact product, current price, suitability and availability with a pharmacist or doctor.", confidence=0.82, source="Local demonstration dataset — not live government data"))
            db.add(LegacyMedicine(search_terms="thyronorm|thyroxine", name="Thyroxine 100 mcg (illustrative entry)", composition="Thyroxine 100 mcg", strength="100 mcg", form="Tablet", manufacturer="Not verified", brand_price=160, generic_name="No alternative confirmed", generic_composition="", generic_price=None, verdict="ask_doctor", reason="Thyroid medicines may require consistency and monitoring. Ask your prescriber before any brand change.", confidence=0.70, source="Local demonstration dataset — not live government data"))
        # No Kendra rows are preloaded. The supplied source PDF contained only
        # the heading "List of Kendra" and no names, addresses, PIN codes or phones.
        # Do not invent listings; add verified records through the admin dashboard.
        db.commit()

init_db()

APP_SECRET = os.getenv("APP_SECRET", "local-development-secret-change-before-deploy")
serializer = URLSafeTimedSerializer(APP_SECRET, salt="medsetu-admin-session")
app = FastAPI(title="MedSetu API", description="Educational prototype. MedSetu informs; it never prescribes.", version="1.0.0")
app.mount("/static", StaticFiles(directory=ROOT / "frontend" / "static"), name="static")

class CompareRequest(BaseModel):
    query: Optional[str] = None
    medicine_name: Optional[str] = None
    medicine: Optional[str] = None
class LoginRequest(BaseModel):
    username: str
    password: str
class MedicineInput(BaseModel):
    medicine_id: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=250)
    generic_name: Optional[str] = None
    composition: Optional[str] = None
    strength: Optional[str] = None
    dosage_form: Optional[str] = None
    route: Optional[str] = None
    manufacturer: Optional[str] = None
    demo_price_inr: Optional[float] = Field(default=None, ge=0)
    data_status: str = "DEMO_ONLY"
class KendraInput(BaseModel):
    name: str = Field(min_length=1, max_length=250)
    address: str = Field(min_length=1, max_length=1000)
    pincode: Optional[str] = None
    phone: Optional[str] = None
    verified: bool = False

def admin_user(): return os.getenv("MEDSETU_ADMIN_USERNAME", "")
def admin_password(): return os.getenv("MEDSETU_ADMIN_PASSWORD", "")
def require_admin(request: Request):
    token = request.cookies.get("medsetu_admin")
    if not token:
        raise HTTPException(status_code=401, detail="Admin login required")
    try:
        payload = serializer.loads(token, max_age=8 * 60 * 60)
    except (BadSignature, SignatureExpired):
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    if not admin_user() or payload.get("u") != admin_user():
        raise HTTPException(status_code=401, detail="Admin session is invalid")
    return payload["u"]

@app.get("/")
def frontend_home(): return FileResponse(ROOT / "frontend" / "index.html")
@app.get("/admin", response_class=HTMLResponse)
def admin_page(): return FileResponse(ROOT / "frontend" / "admin.html")
@app.get("/sw.js")
def service_worker(): return FileResponse(ROOT / "frontend" / "sw.js", media_type="application/javascript", headers={"Cache-Control":"no-cache"})
@app.get("/health")
@app.get("/api/health")
def health(): return {"status":"ok", "database":"connected", "database_type":"postgresql" if DATABASE_URL.startswith("postgresql") else "sqlite-local"}
@app.get("/api/info")
def api_info(): return {"name":"MedSetu API", "status":"running", "docs":"/docs", "notice":"Educational prototype. MedSetu informs; it never prescribes."}

@app.post("/api/compare")
@app.post("/compare")
@app.post("/api/search")
@app.post("/search")
def compare(payload: CompareRequest, db: Session = Depends(get_db)):
    query=(payload.query or payload.medicine_name or payload.medicine or "").strip()
    if not query: return {"result":{"name":"", "verdict":"not_enough_data", "reason":"Enter a medicine name to search."}}
    q=query.lower()
    legacy=db.scalars(select(LegacyMedicine)).all()
    match=next((r for r in legacy if any(t.strip().lower() in q or q in t.strip().lower() for t in r.search_terms.split("|"))),None)
    if match:
        d={k:getattr(match,k) for k in ["name","composition","strength","form","manufacturer","brand_price","generic_name","generic_composition","generic_price","verdict","reason","confidence","source"]}
        d["saving"]=round(d["brand_price"]-d["generic_price"],2) if d["brand_price"] is not None and d["generic_price"] is not None else None
        return {"result":d}
    c=db.scalar(select(CatalogueMedicine).where(or_(func.lower(CatalogueMedicine.display_name).like(f"%{q}%"),func.lower(CatalogueMedicine.generic_name).like(f"%{q}%"),func.lower(CatalogueMedicine.composition).like(f"%{q}%"),func.lower(CatalogueMedicine.medicine_id)==q)).limit(1))
    if c:
        return {"result":{"name":c.display_name,"composition":c.composition,"strength":c.strength,"form":c.dosage_form,"manufacturer":c.manufacturer,"brand_price":c.demo_price_inr,"generic_name":"No verified alternative in this catalogue","generic_composition":"","generic_price":None,"verdict":"not_enough_data","reason":"Illustrative catalogue listing only. Price and manufacturer are demo values; no clinically interchangeable alternative has been verified. Ask a registered pharmacist or doctor before any change.","confidence":None,"source":"MedSetu bundled demo catalogue — fictional test data, not live market data","data_status":c.data_status,"route":c.route}}
    return {"result":{"name":query,"composition":"Not available in the local prototype dataset","brand_price":None,"generic_name":"No verified equivalent found","generic_price":None,"verdict":"not_enough_data","reason":"No reliable match exists in this prototype dataset. Do not infer equivalence from a similar name. Ask a pharmacist or doctor.","confidence":0,"source":"No matching local record"}}

@app.get("/api/medicines")
def list_catalogue_medicines(q: str=Query(default=""), limit: int=Query(default=50,ge=1,le=200), db: Session=Depends(get_db)):
    term=f"%{q.strip().lower()}%"
    stmt=select(CatalogueMedicine).where(or_(q.strip()=="",func.lower(CatalogueMedicine.display_name).like(term),func.lower(CatalogueMedicine.generic_name).like(term),func.lower(CatalogueMedicine.composition).like(term))).order_by(CatalogueMedicine.display_name).limit(limit)
    rows=db.scalars(stmt).all()
    return {"count":len(rows),"results":[medicine_dict(r) for r in rows],"notice":"DEMO DATA ONLY: prices and manufacturer names may be fictional; no alternative or clinical equivalence is verified."}

def medicine_dict(r):
    return {"medicine_id":r.medicine_id,"display_name":r.display_name,"generic_name":r.generic_name,"composition":r.composition,"strength":r.strength,"dosage_form":r.dosage_form,"route":r.route,"manufacturer":r.manufacturer,"demo_price_inr":r.demo_price_inr,"data_status":r.data_status}
@app.get("/api/kendras")
@app.get("/kendras")
@app.get("/api/locator")
def get_kendras(q: str=Query(default=""), location: str=Query(default=""), db: Session=Depends(get_db)):
    term=(q or location).strip().lower()
    stmt=select(Kendra).where(Kendra.verified.is_(True), ~func.lower(Kendra.address).like("%sample listing only%"))
    if term:
        like=f"%{term}%"; stmt=stmt.where(or_(func.lower(Kendra.name).like(like),func.lower(Kendra.address).like(like),func.lower(Kendra.pincode).like(like)))
    rows=db.scalars(stmt.order_by(Kendra.name)).all()
    return {"results":[{"name":r.name,"address":r.address,"pincode":r.pincode,"phone":r.phone,"verified":r.verified} for r in rows],"count":len(rows),"searched_location":term,"notice":"Only locally stored Kendra records are searched. No verified live PMBI directory or stock feed is connected. Confirm address, opening hours and stock before travelling."}

@app.post("/api/admin/login")
def admin_login(data: LoginRequest, response: Response, request: Request):
    u,p=admin_user(),admin_password()
    if not u or not p: raise HTTPException(status_code=503,detail="Admin credentials are not configured on the server")
    if not hmac.compare_digest(data.username,u) or not hmac.compare_digest(data.password,p):
        time.sleep(0.5); raise HTTPException(status_code=401,detail="Incorrect username or password")
    token=serializer.dumps({"u":u,"nonce":secrets.token_hex(8)})
    response.set_cookie("medsetu_admin",token,httponly=True,secure=(os.getenv("COOKIE_SECURE", "").lower()=="true") if os.getenv("COOKIE_SECURE") else request.url.scheme == "https",samesite="strict",max_age=8*60*60,path="/")
    return {"ok":True,"message":"Logged in"}
@app.post("/api/admin/logout")
def admin_logout(response: Response):
    response.delete_cookie("medsetu_admin",path="/"); return {"ok":True}
@app.get("/api/admin/me")
def admin_me(_:str=Depends(require_admin)): return {"authenticated":True}
@app.get("/api/admin/medicines")
def admin_list_medicines(_:str=Depends(require_admin),db:Session=Depends(get_db)):
    return {"results":[medicine_dict(r) for r in db.scalars(select(CatalogueMedicine).order_by(CatalogueMedicine.display_name)).all()]}
@app.post("/api/admin/medicines")
def admin_add_medicine(data:MedicineInput,_:str=Depends(require_admin),db:Session=Depends(get_db)):
    if db.get(CatalogueMedicine,data.medicine_id): raise HTTPException(409,"Medicine ID already exists")
    row=CatalogueMedicine(**data.model_dump()); db.add(row); db.commit(); return medicine_dict(row)
@app.put("/api/admin/medicines/{medicine_id}")
def admin_update_medicine(medicine_id:str,data:MedicineInput,_:str=Depends(require_admin),db:Session=Depends(get_db)):
    row=db.get(CatalogueMedicine,medicine_id)
    if not row: raise HTTPException(404,"Medicine not found")
    for k,v in data.model_dump().items(): setattr(row,k,v)
    db.commit(); return medicine_dict(row)
@app.delete("/api/admin/medicines/{medicine_id}")
def admin_delete_medicine(medicine_id:str,_:str=Depends(require_admin),db:Session=Depends(get_db)):
    row=db.get(CatalogueMedicine,medicine_id)
    if not row: raise HTTPException(404,"Medicine not found")
    db.delete(row); db.commit(); return {"ok":True}
@app.get("/api/admin/kendras")
def admin_list_kendras(_:str=Depends(require_admin),db:Session=Depends(get_db)):
    return {"results":[{"id":r.id,"name":r.name,"address":r.address,"pincode":r.pincode,"phone":r.phone,"verified":r.verified} for r in db.scalars(select(Kendra).order_by(Kendra.name)).all()]}
@app.post("/api/admin/kendras")
def admin_add_kendra(data:KendraInput,_:str=Depends(require_admin),db:Session=Depends(get_db)):
    row=Kendra(**data.model_dump()); db.add(row); db.commit(); return {"id":row.id,"name":row.name}
@app.put("/api/admin/kendras/{kendra_id}")
def admin_update_kendra(kendra_id:int,data:KendraInput,_:str=Depends(require_admin),db:Session=Depends(get_db)):
    row=db.get(Kendra,kendra_id)
    if not row: raise HTTPException(404,"Kendra not found")
    for k,v in data.model_dump().items(): setattr(row,k,v)
    db.commit(); return {"id":row.id,"name":row.name}
@app.delete("/api/admin/kendras/{kendra_id}")
def admin_delete_kendra(kendra_id:int,_:str=Depends(require_admin),db:Session=Depends(get_db)):
    row=db.get(Kendra,kendra_id)
    if not row: raise HTTPException(404,"Kendra not found")
    db.delete(row); db.commit(); return {"ok":True}

@app.post("/api/ocr")
@app.post("/ocr")
async def ocr(file:UploadFile=File(...)):
    content=await file.read()
    if not content: return {"text":"","message":"The uploaded file is empty."}
    try:
        from PIL import Image
        import pytesseract,io
        return {"text":pytesseract.image_to_string(Image.open(io.BytesIO(content))),"message":"OCR text is unverified. Review every character and medicine detail."}
    except ImportError: return {"text":"","message":"OCR dependencies are not installed. Install optional requirements and Tesseract OCR to enable image text extraction."}
    except Exception as exc: return {"text":"","message":f"OCR could not read this image: {exc}"}
