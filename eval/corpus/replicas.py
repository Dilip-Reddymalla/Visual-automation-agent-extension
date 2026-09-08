"""The replica half of the corpus.

Twenty-five pages modelled on real Indian portals, banks and marketplaces. Modelled, not
captured, and the report says so in those words -- see the module docstring in pages.py
for why fetching and anonymising twenty-five live sites was not the safe route here, and
eval/capture/ for the pipeline that turns a genuine capture into a corpus page when one
is available.

What is replicated is the part a detector actually trips over. Real portals do not look
like the clean archetypes in specs.py:

  - values sit in `<td>` cells with no `<label>` anywhere near them
  - inputs carry a `name` and a `placeholder` and nothing else
  - the accessible name is three divs away, or is an adjacent `<span>` styled to look
    like a label without being one
  - identifiers appear in running prose, mid-sentence
  - a `<div role="button">` does the work of a button
  - the same identifier appears twice, once masked by the site and once not
  - layout is nested six or seven levels deep for no reason anyone remembers

Each of those is a real failure mode, and a corpus of tidy forms would report a precision
number that evaporates on contact with any actual government website.
"""

from __future__ import annotations

import pixels
from pages import bar, buttons, el, esc, field, kv, neg, pii, pixel_pii, sidenav, table
from specs import _np, gov_ration_card, job_profile
from values import Values


# -- Shapes the real sites share ----------------------------------------------


def nested(depth: int, inner: str) -> str:
    """Wrap `inner` in `depth` pointless divs, which is how the real pages are built."""
    out = inner
    for i in range(depth):
        out = f'<div class="lvl{i}">{out}</div>'
    return out


def pseudo_field(label: str, value: str, cls: str | None = None, *,
                 name: str = "", masked: str = "") -> str:
    """An input whose label is a styled span rather than a `<label>`.

    Nothing associates the two: no `for`, no `aria-labelledby`, no wrapping. The
    accessible name has to come from somewhere else or not at all, which is what makes
    these pages worth having.
    """
    mark = f' data-pii="{cls}"' if cls else ""
    nm = f' name="{esc(name)}"' if name else ""
    hint = f'<span class="fake-hint">{esc(masked)}</span>' if masked else ""
    return (
        f'<div class="rowf"><span class="fake-label">{label}</span>'
        f'<input type="text"{nm} value="{esc(value)}" placeholder="{label}" '
        f'{el()}{mark} />{hint}</div>'
    )


def cell_kv(rows: list[tuple[str, str]]) -> str:
    """A key/value block built out of a table, because that is what these sites do."""
    body = "".join(
        f'<tr><td class="k">{k}</td><td class="v">{v}</td></tr>' for k, v in rows
    )
    return f'<table class="kvtable"><tbody>{body}</tbody></table>'


def div_button(text: str) -> str:
    return f'<div role="button" tabindex="0" class="divbtn" {el()}>{esc(text)}</div>'


REPLICA_CSS = """
<style>
  .lvl0,.lvl1,.lvl2,.lvl3,.lvl4,.lvl5,.lvl6 { display: block; }
  .rowf { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .fake-label { flex: 0 0 190px; color: #5b6472; font-size: .85em; text-align: right; }
  .rowf input { flex: 1 1 auto; }
  .fake-hint { flex: 0 0 auto; color: #8b95a3; font-size: .8em; }
  table.kvtable td { border-bottom: 1px dotted #dfe4ec; padding: 5px 8px; }
  table.kvtable td.k { color: #5b6472; width: 220px; font-size: .88em; }
  .divbtn {
    display: inline-block; padding: 7px 14px; border: 1px solid #c9d0da;
    border-radius: 3px; background: #eef2f7; cursor: pointer; user-select: none;
  }
  .tabs { display: flex; gap: 2px; border-bottom: 2px solid #c9d0da; margin-bottom: 12px; }
  .tabs [role=tab] { padding: 7px 14px; cursor: pointer; background: #f2f5f9; }
  .tabs [role=tab][aria-selected=true] { background: #fff; font-weight: 600; }
  .marquee { background: #fffbe6; border: 1px solid #f0e0a0; padding: 6px 10px;
             font-size: .85em; margin-bottom: 10px; }
</style>
"""


# -- Bespoke replicas ----------------------------------------------------------


def irctc_pnr(v: Values, n) -> str:
    """PNR status: a passenger table, values in cells, no labels at all."""
    rows = []
    for i in range(4):
        rows.append([
            str(i + 1),
            pii(v.person(), 'PERSON'),
            str(v.rng.randint(19, 64)),
            'M' if i % 2 else 'F',
            f'S{v.rng.randint(1, 9)} / {v.rng.randint(1, 72)}',
            'CNF',
        ])
    return f"""{REPLICA_CSS}
{bar('Indian Railways — Passenger Reservation')}
<div class="marquee">Beware of touts. Tickets booked on this PNR are non-transferable.</div>
<main>{nested(4, f'''
  <h1>PNR status</h1>
  {cell_kv([('PNR', neg(*_np(n))), ('Train', '12658 — Bengaluru Mail'),
            ('Date of journey', neg(*_np(n))),
            ('Booked by', pii(v.person(), 'PERSON')),
            ('Contact', pii(v.phone(), 'PHONE')),
            ('Booking email', pii(v.email(), 'EMAIL'))])}
  {table(['#', 'Passenger', 'Age', 'Gender', 'Coach / Berth', 'Status'], rows)}
  <p>An SMS has been sent to {pii(v.phone(), 'PHONE')}. Cancellation charges apply as
     per {neg(*_np(n))}.</p>
  <div>{div_button('Cancel ticket')} {div_button('Print ERS')}</div>
''')}</main>"""


def epfo_passbook(v: Values, n) -> str:
    """EPFO member passbook: a UAN, a masked Aadhaar, and a long contributions table."""
    rows = []
    for month in ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']:
        rows.append([f'{month} 2026', '6,480', '1,980', '4,500', '2,14,880'])
    return f"""{REPLICA_CSS}
{bar('EPFO — Member Passbook', 'UAN ' + neg(*_np(n)))}
<main>{nested(5, f'''
  <div class="tabs">
    <div role="tab" aria-selected="true" {el()}>Passbook</div>
    <div role="tab" {el()}>KYC</div>
    <div role="tab" {el()}>Claims</div>
  </div>
  {cell_kv([('Member name', pii(v.person(), 'PERSON')),
            ('Father / Spouse', pii(v.person(), 'PERSON')),
            ('Date of birth', pii(v.dob(), 'DOB')),
            ('Aadhaar (verified)', pii(v.aadhaar(), 'AADHAAR')),
            ('PAN (verified)', pii(v.pan(), 'PAN')),
            ('Bank account', pii(v.account(), 'ACCOUNT')),
            ('IFSC', pii(v.ifsc(), 'IFSC')),
            ('Establishment', pii(v.org(), 'ORG')),
            ('Office', neg(*_np(n)))])}
  {table(['Month', 'Employee', 'Pension', 'Employer', 'Balance'], rows, numeric=set([1, 2, 3, 4]))}
  <div>{div_button('Download passbook')}</div>
''')}</main>"""


def incometax_dashboard(v: Values, n) -> str:
    """e-Filing dashboard: PAN in the header, everything else in nested panels."""
    name = v.person()
    return f"""{REPLICA_CSS}
{bar('Income Tax e-Filing', pii(v.pan(), 'PAN'))}
<main>{nested(6, f'''
  <h1>Welcome, {pii(name, 'PERSON')}</h1>
  <div class="tabs">
    <div role="tab" aria-selected="true" {el()}>Dashboard</div>
    <div role="tab" {el()}>e-File</div>
    <div role="tab" {el()}>Authorised partners</div>
  </div>
  {cell_kv([('Aadhaar linked', pii(v.aadhaar(), 'AADHAAR')),
            ('Date of birth', pii(v.dob(), 'DOB')),
            ('Primary mobile', pii(v.phone(), 'PHONE')),
            ('Primary email', pii(v.email(name), 'EMAIL')),
            ('Address on record', pii(v.address(), 'ADDRESS')),
            ('Bank for refund', pii(v.account(), 'ACCOUNT')),
            ('Last login', neg(*_np(n))),
            ('Acknowledgement', neg(*_np(n)))])}
  <p>Your return for AY 2025-26 was processed. The refund was credited to the account
     ending {pii(v.account()[-4:], 'ACCOUNT')} against {neg(*_np(n))}.</p>
  <div>{div_button('File a return')} {div_button('View 26AS')}</div>
''')}</main>"""


def digilocker_issued(v: Values, n) -> str:
    """Issued documents, with the identity card as pixels and a text list beside it."""
    name = v.person()
    uri = pixels.id_card(name, v.aadhaar(), v.dob(), v.address())
    rows = [
        ['Aadhaar', 'UIDAI', neg(*_np(n)), 'Verified'],
        ['Driving licence', 'Transport Dept', pii(v.licence(), 'LICENCE'), 'Verified'],
        ['PAN verification', 'ITD', pii(v.pan(), 'PAN'), 'Verified'],
        ['Class X marksheet', 'CBSE', neg(*_np(n)), 'Verified'],
    ]
    return f"""{REPLICA_CSS}
{bar('DigiLocker', pii(name, 'PERSON'))}
<main>{nested(3, f'''
  <h1>Issued documents</h1>
  {table(['Document', 'Issuer', 'Number', 'Status'], rows)}
  <div class="scanwrap">{pixel_pii(uri, 'AADHAAR', 460, 280, alt='Aadhaar')}</div>
  <p>Documents are fetched live from the issuer. Nothing is stored on this device.
     Support: {neg(*_np(n))}.</p>
  <div>{div_button('Share')} {div_button('Refresh')}</div>
''')}</main>"""


def sbi_transfer(v: Values, n) -> str:
    """A netbanking transfer built entirely from pseudo-fields."""
    return f"""{REPLICA_CSS}
{bar('OnlineSBI', 'Last login ' + neg(*_np(n)))}
<main>{nested(5, f'''
  <h1>Transfer to another bank</h1>
  {pseudo_field('Beneficiary name', v.person(), 'PERSON', name='benName')}
  {pseudo_field('Beneficiary account', v.account(), 'ACCOUNT', name='benAcc')}
  {pseudo_field('Confirm account', v.account(), 'ACCOUNT', name='benAcc2')}
  {pseudo_field('IFS code', v.ifsc(), 'IFSC', name='ifsc')}
  <p class="hint">Format example: {neg(*_np(n))}</p>
  {pseudo_field('Amount', '25000', None, name='amt')}
  {pseudo_field('Remarks', 'Rent for September', None, name='rem')}
  <div class="rowf"><span class="fake-label">Profile password</span>
    <input type="password" name="pp" value="{esc(v.secret())}" {el()} data-pii="SECRET" /></div>
  <p>An OTP will be sent to the mobile registered with the bank,
     {pii(v.phone(), 'PHONE')}. Reference {neg(*_np(n))}.</p>
  <div>{div_button('Back')} {div_button('Confirm transfer')}</div>
''')}</main>"""


def hdfc_card_bill(v: Values, n) -> str:
    """A card bill where the site itself masks the number, beside one it does not."""
    card = v.card()
    masked = 'XXXX XXXX XXXX ' + card[-4:]
    rows = [
        ['03 Sep', 'BIGBASKET BENGALURU', neg(*_np(n)), '2,145.00'],
        ['09 Sep', 'IRCTC WEB', neg(*_np(n)), '1,890.00'],
        ['16 Sep', 'AIRTEL POSTPAID', neg(*_np(n)), '799.00'],
        ['24 Sep', 'APOLLO PHARMACY', neg(*_np(n)), '612.50'],
    ]
    return f"""{REPLICA_CSS}
{bar('Credit Cards', masked)}
<main>{nested(4, f'''
  <h1>Statement for September</h1>
  {cell_kv([('Name on card', pii(v.person(), 'PERSON')),
            ('Card number', pii(card, 'CARD')),
            ('Alternate card', masked),
            ('Billing address', pii(v.address(), 'ADDRESS')),
            ('Payment due', neg(*_np(n))),
            ('Autopay UPI', pii(v.upi(), 'UPI'))])}
  {table(['Date', 'Merchant', 'Approval', 'Amount'], rows, numeric=set([3]))}
  <p>Pay by {neg(*_np(n))} to avoid interest. Queries: {neg(*_np(n))}.</p>
  <div>{div_button('Pay now')} {div_button('Download')}</div>
''')}</main>"""


def paytm_history(v: Values, n) -> str:
    """A wallet history: UPI handles everywhere, most belonging to merchants."""
    # Two of the five counterparties are businesses. A handle is not PII because it is a
    # handle -- it is PII because it names a person, and telling the two apart is the
    # whole difficulty. Both kinds sit in the same column, formatted identically.
    rows = []
    for label, handle, amount, personal in [
        ('Paid to', v.upi(), '240', True),
        ('Received from', v.upi(), '1,500', True),
        ('Paid to', 'bescom.bill@okaxis', '2,310', False),
        ('Paid to', 'merchant0042@ybl', '99', False),
        ('Sent to', v.upi(), '5,000', True),
    ]:
        cell = (
            pii(handle, 'UPI') if personal
            else neg(handle, 'UPI', 'a business collection handle, not a person')
        )
        rows.append([neg(*_np(n)), label, cell, amount])
    return f"""{REPLICA_CSS}
{bar('Wallet', pii(v.phone(), 'PHONE'))}
<main>{nested(3, f'''
  <h1>Transaction history</h1>
  {cell_kv([('Account holder', pii(v.person(), 'PERSON')),
            ('Linked bank', pii(v.account(), 'ACCOUNT')),
            ('Primary UPI', pii(v.upi(), 'UPI')),
            ('KYC status', 'Full KYC, verified against Aadhaar')])}
  {table(['Txn', 'Type', 'Counterparty', 'Amount'], rows, numeric=set([3]))}
  <div>{div_button('Add money')} {div_button('Statement')}</div>
''')}</main>"""


def flipkart_checkout(v: Values, n) -> str:
    """Checkout with the address as an unlabelled block and a card in a pseudo-field."""
    name = v.person()
    return f"""{REPLICA_CSS}
{bar('Marketplace', 'Secure checkout')}
<main>{nested(6, f'''
  <h1>Order summary</h1>
  <div class="card">
    <strong>Deliver to</strong>
    <div>{pii(name, 'PERSON')}, {pii(v.address(), 'ADDRESS')}</div>
    <div>Phone {pii(v.phone(), 'PHONE')}</div>
    {div_button('Change')}
  </div>
  <div class="card">
    <strong>Payment</strong>
    {pseudo_field('Card number', v.card(), 'CARD', name='cc')}
    {pseudo_field('Name on card', name, 'PERSON', name='ccname')}
    {pseudo_field('Expiry', '11/28', None, name='exp')}
    <div class="rowf"><span class="fake-label">CVV</span>
      <input type="password" name="cvv" {el()} data-pii="SECRET" /></div>
    {pseudo_field('Or UPI ID', v.upi(), 'UPI', name='upi')}
  </div>
  {cell_kv([('Order', neg(*_np(n))), ('Delivery', neg(*_np(n))),
            ('Total', neg(*_np(n)))])}
  <div>{div_button('Place order')}</div>
''')}</main>"""


def bescom_bill(v: Values, n) -> str:
    """A utility bill: a consumer number that is not PII beside an address that is."""
    return f"""{REPLICA_CSS}
{bar('Electricity Supply Company', 'Bill')}
<main>{nested(4, f'''
  <h1>Current bill</h1>
  {cell_kv([('Consumer name', pii(v.person(), 'PERSON')),
            ('Consumer number', neg(*_np(n))),
            ('Installation address', pii(v.address(), 'ADDRESS')),
            ('Registered mobile', pii(v.phone(), 'PHONE')),
            ('Bill number', neg(*_np(n))),
            ('Due date', neg(*_np(n))),
            ('Pay to', neg(*_np(n)))])}
  {table(['Reading', 'Units', 'Rate', 'Amount'],
         [['Previous 41820', '—', '—', '—'],
          ['Current 42145', '325', '7.10', '2,307.50']], numeric=set([1, 2, 3]))}
  <p>Payments can be made from any UPI app to the collection handle printed above.
     Complaints: {neg(*_np(n))}.</p>
  <div>{div_button('Pay bill')} {div_button('Past bills')}</div>
''')}</main>"""


def rto_licence(v: Values, n) -> str:
    """Driving licence status: the licence number in a heading, not a field."""
    lic = v.licence()
    return f"""{REPLICA_CSS}
{bar('Transport Department', 'Sarathi')}
<main>{nested(5, f'''
  <h1>Licence {pii(lic, 'LICENCE')}</h1>
  {cell_kv([('Holder', pii(v.person(), 'PERSON')),
            ('Date of birth', pii(v.dob(), 'DOB')),
            ('Blood group', 'B+'),
            ('Address', pii(v.address(), 'ADDRESS')),
            ('Issued on', neg(*_np(n))),
            ('Valid till', neg(*_np(n))),
            ('Issuing RTO', neg(*_np(n))),
            ('Format example', neg(*_np(n)))])}
  <p>Renewal must be applied for within thirty days of expiry. Verify identity with
     Aadhaar {pii(v.aadhaar(), 'AADHAAR')} at the counter.</p>
  <div>{div_button('Apply for renewal')} {div_button('Print extract')}</div>
''')}</main>"""


# -- Parameterised replicas ----------------------------------------------------
#
# Three shapes, instantiated with genuinely different content. The shapes are shared
# because the real sites share them -- a left-nav portal, a records table, a profile
# card are what most of the Indian public web is built out of -- and duplicating the
# markup by hand would add pages that score identically while pretending to be evidence.


def portal_form(brand: str, heading: str, nav: list[str], fields: list[tuple],
                prose: str, depth: int = 5):
    def build(v: Values, n) -> str:
        rows = "".join(
            pseudo_field(label, getter(v), cls, name=label.lower().replace(' ', ''))
            for label, getter, cls in fields
        )
        return f"""{REPLICA_CSS}
{bar(brand, neg(*_np(n)))}
<main><div class="cols"><div class="side">{sidenav(nav, 1)}</div>
<div class="pane">{nested(depth, f'''
  <h1>{heading}</h1>
  {rows}
  <p>{prose.format(a=pii(v.phone(), 'PHONE'), b=pii(v.email(), 'EMAIL'),
                   c=neg(*_np(n)))}</p>
  <div>{div_button('Save')} {div_button('Submit')}</div>
''')}</div></div></main>"""
    return build


def records_table(brand: str, heading: str, headers: list[str],
                  row_builder, count: int, summary: list[tuple], depth: int = 4):
    def build(v: Values, n) -> str:
        rows = [row_builder(v, n, i) for i in range(count)]
        return f"""{REPLICA_CSS}
{bar(brand, neg(*_np(n)))}
<main>{nested(depth, f'''
  <h1>{heading}</h1>
  {cell_kv([(k, g(v, n)) for k, g in summary])}
  {table(headers, rows)}
  <p>Records are shown for the last twelve months. Reference {neg(*_np(n))}.</p>
  <div>{div_button('Export')} {div_button('Filter')}</div>
''')}</main>"""
    return build


def profile_card(brand: str, heading: str, rows: list[tuple], prose: str, depth: int = 3):
    def build(v: Values, n) -> str:
        return f"""{REPLICA_CSS}
{bar(brand, neg(*_np(n)))}
<main>{nested(depth, f'''
  <h1>{heading}</h1>
  {cell_kv([(k, g(v, n)) for k, g in rows])}
  <p>{prose.format(a=pii(v.person(), 'PERSON'), b=pii(v.address(), 'ADDRESS'),
                   c=neg(*_np(n)))}</p>
  <div>{div_button('Edit')} {div_button('Verify')}</div>
''')}</main>"""
    return build


# Getters, so the parameterised shapes stay data rather than closures over a page.
G = {
    'person': lambda v, n=None: pii(v.person(), 'PERSON'),
    'dob': lambda v, n=None: pii(v.dob(), 'DOB'),
    'aadhaar': lambda v, n=None: pii(v.aadhaar(), 'AADHAAR'),
    'pan': lambda v, n=None: pii(v.pan(), 'PAN'),
    'phone': lambda v, n=None: pii(v.phone(), 'PHONE'),
    'email': lambda v, n=None: pii(v.email(), 'EMAIL'),
    'address': lambda v, n=None: pii(v.address(), 'ADDRESS'),
    'account': lambda v, n=None: pii(v.account(), 'ACCOUNT'),
    'ifsc': lambda v, n=None: pii(v.ifsc(), 'IFSC'),
    'upi': lambda v, n=None: pii(v.upi(), 'UPI'),
    'card': lambda v, n=None: pii(v.card(), 'CARD'),
    'passport': lambda v, n=None: pii(v.passport(), 'PASSPORT'),
    'licence': lambda v, n=None: pii(v.licence(), 'LICENCE'),
    'gstin': lambda v, n=None: pii(v.gstin(), 'GSTIN'),
    'org': lambda v, n=None: pii(v.org(), 'ORG'),
    'trap': lambda v, n: neg(*_np(n)),
}
RAW = {
    'person': lambda v: v.person(), 'dob': lambda v: v.dob(),
    'aadhaar': lambda v: v.aadhaar(), 'pan': lambda v: v.pan(),
    'phone': lambda v: v.phone(), 'email': lambda v: v.email(),
    'address': lambda v: v.address(), 'account': lambda v: v.account(),
    'ifsc': lambda v: v.ifsc(), 'upi': lambda v: v.upi(),
    'card': lambda v: v.card(), 'passport': lambda v: v.passport(),
    'licence': lambda v: v.licence(), 'gstin': lambda v: v.gstin(),
    'secret': lambda v: v.secret(),
}


def _member_row(v: Values, n, i: int) -> list[str]:
    return [str(i + 1), G['person'](v), G['dob'](v), G['aadhaar'](v), G['trap'](v, n)]


def _txn_row(v: Values, n, i: int) -> list[str]:
    return [G['trap'](v, n), G['person'](v), G['upi'](v), f'{(i + 1) * 1250:,}']


def _claim_row(v: Values, n, i: int) -> list[str]:
    return [G['trap'](v, n), G['person'](v), G['account'](v), ['Open', 'Settled', 'Query'][i % 3]]


REPLICAS = [
    ("rep-irctc-pnr", "PNR Status", "transport", irctc_pnr, "gov", "compact", 13),
    ("rep-epfo-passbook", "EPFO Member Passbook", "gov-form", epfo_passbook, "gov", "compact", 12),
    ("rep-itd-dashboard", "e-Filing Dashboard", "gov-form", incometax_dashboard, "portal", "normal", 14),
    ("rep-digilocker", "DigiLocker — Issued", "scanned-id", digilocker_issued, "portal", "normal", 15),
    ("rep-sbi-transfer", "OnlineSBI — Transfer", "bank-statement", sbi_transfer, "bank", "compact", 13),
    ("rep-hdfc-card", "Credit Card Bill", "bank-statement", hdfc_card_bill, "bank", "compact", 12),
    ("rep-wallet-history", "Wallet History", "ecommerce", paytm_history, "shop", "normal", 14),
    ("rep-market-checkout", "Marketplace Checkout", "ecommerce", flipkart_checkout, "shop", "normal", 15),
    ("rep-utility-bill", "Electricity Bill", "utility", bescom_bill, "portal", "compact", 13),
    ("rep-rto-licence", "Driving Licence Status", "transport", rto_licence, "gov", "normal", 14),
    ("rep-ration-household", "Ration Card — Household", "gov-form", gov_ration_card, "gov", "compact", 13),
    ("rep-talent-profile", "Candidate Profile", "job-application", job_profile, "portal", "roomy", 18),

    ("rep-nps-account", "NPS — Subscriber Details", "gov-form",
     portal_form("NPS Trust", "Subscriber details",
                 ["Home", "Profile", "Contributions", "Withdrawal"],
                 [("PRAN holder", RAW['person'], "PERSON"),
                  ("Date of birth", RAW['dob'], "DOB"),
                  ("PAN", RAW['pan'], "PAN"),
                  ("Aadhaar", RAW['aadhaar'], "AADHAAR"),
                  ("Bank account", RAW['account'], "ACCOUNT"),
                  ("IFSC", RAW['ifsc'], "IFSC")],
                 "Statements are posted to {b} and alerts to {a}. Scheme reference {c}."),
     "portal", "normal", 14),

    ("rep-gst-registration", "GST — Registration", "gov-form",
     portal_form("GST Portal", "Business registration",
                 ["Dashboard", "Registration", "Returns", "Payments"],
                 [("Legal name", RAW['person'], "PERSON"),
                  ("GSTIN", RAW['gstin'], "GSTIN"),
                  ("PAN of business", RAW['pan'], "PAN"),
                  ("Principal place", RAW['address'], "ADDRESS"),
                  ("Authorised mobile", RAW['phone'], "PHONE"),
                  ("Authorised email", RAW['email'], "EMAIL")],
                 "Amendments are notified to {a} and {b}. Application {c}.", depth=6),
     "gov", "compact", 12),

    ("rep-univ-admission", "University Admission", "scholarship",
     portal_form("State University", "Admission form",
                 ["Apply", "Documents", "Fee", "Status"],
                 [("Candidate name", RAW['person'], "PERSON"),
                  ("Date of birth", RAW['dob'], "DOB"),
                  ("Aadhaar", RAW['aadhaar'], "AADHAAR"),
                  ("Guardian mobile", RAW['phone'], "PHONE"),
                  ("Correspondence address", RAW['address'], "ADDRESS"),
                  ("Fee account", RAW['account'], "ACCOUNT")],
                 "Admit cards go to {b}. Helpdesk {c}, or call {a}."),
     "portal", "normal", 15),

    ("rep-kyc-update", "KYC Update", "bank-statement",
     portal_form("Bank — KYC", "Update your KYC",
                 ["Accounts", "KYC", "Nominee", "Service requests"],
                 [("Name as per PAN", RAW['person'], "PERSON"),
                  ("PAN", RAW['pan'], "PAN"),
                  ("Aadhaar", RAW['aadhaar'], "AADHAAR"),
                  ("Passport", RAW['passport'], "PASSPORT"),
                  ("Communication address", RAW['address'], "ADDRESS"),
                  ("Mobile", RAW['phone'], "PHONE")],
                 "A confirmation goes to {b}. Service request {c}.", depth=7),
     "bank", "compact", 13),

    ("rep-telecom-bill", "Postpaid Bill", "utility",
     portal_form("Telecom", "Postpaid account",
                 ["Overview", "Bills", "Plans", "Support"],
                 [("Account holder", RAW['person'], "PERSON"),
                  ("Billing address", RAW['address'], "ADDRESS"),
                  ("Alternate contact", RAW['phone'], "PHONE"),
                  ("Email for bills", RAW['email'], "EMAIL"),
                  ("Autopay card", RAW['card'], "CARD"),
                  ("Autopay UPI", RAW['upi'], "UPI")],
                 "Bills are emailed to {b} on the 3rd. Account {c}."),
     "portal", "normal", 14),

    ("rep-pf-members", "Establishment — Members", "gov-form",
     records_table("EPFO Employer", "Members of this establishment",
                   ["#", "Member", "Date of birth", "Aadhaar", "UAN"],
                   _member_row, 6,
                   [("Establishment", G['org']), ("Employer PAN", G['pan']),
                    ("Registered office", G['address']), ("Code", G['trap'])]),
     "gov", "compact", 12),

    ("rep-upi-ledger", "UPI Ledger", "ecommerce",
     records_table("Payments", "UPI ledger",
                   ["Txn", "Counterparty", "Handle", "Amount"],
                   _txn_row, 7,
                   [("Account holder", G['person']), ("Linked account", G['account']),
                    ("IFSC", G['ifsc']), ("Statement period", G['trap'])]),
     "bank", "compact", 13),

    ("rep-insurer-claims", "Insurer — Claims Queue", "insurance",
     records_table("Sampoorna", "Claims queue",
                   ["Claim", "Claimant", "Settlement account", "Status"],
                   _claim_row, 6,
                   [("Branch", G['trap']), ("Manager", G['person']),
                    ("Escalation", G['phone']), ("Email", G['email'])]),
     "portal", "normal", 14),

    ("rep-hospital-billing", "Hospital — Billing", "healthcare",
     records_table("Apex Hospitals", "Billing history",
                   ["Invoice", "Patient", "Insurer ID", "Status"],
                   _claim_row, 5,
                   [("Primary patient", G['person']), ("Date of birth", G['dob']),
                    ("Insurer member", G['account']), ("UHID", G['trap']),
                    ("Contact", G['phone'])]),
     "health", "compact", 13),

    ("rep-aadhaar-profile", "Aadhaar — My Profile", "gov-form",
     profile_card("myAadhaar", "Your Aadhaar profile",
                  [("Name", G['person']), ("Aadhaar", G['aadhaar']),
                   ("Date of birth", G['dob']), ("Address", G['address']),
                   ("Mobile", G['phone']), ("Email", G['email']),
                   ("Last update", G['trap']), ("Enrolment", G['trap'])],
                  "Changes are reflected within seven days. Notices go to {b}. "
                  "Reference {c}."),
     "gov", "roomy", 17),

    ("rep-lic-policy", "LIC — Policy Details", "insurance",
     profile_card("Life Insurance", "Policy details",
                  [("Policyholder", G['person']), ("Date of birth", G['dob']),
                   ("Nominee", G['person']), ("PAN", G['pan']),
                   ("Bank for payout", G['account']), ("IFSC", G['ifsc']),
                   ("Policy number", G['trap']), ("Next premium", G['trap'])],
                  "Premium receipts are sent to {b}. Servicing branch {c}."),
     "portal", "normal", 15),

    ("rep-food-profile", "Delivery — Profile", "ecommerce",
     profile_card("Delivery", "Your profile",
                  [("Name", G['person']), ("Phone", G['phone']),
                   ("Email", G['email']), ("Home", G['address']),
                   ("Work", G['address']), ("Saved card", G['card']),
                   ("Saved UPI", G['upi']), ("Member since", G['trap'])],
                  "Orders are delivered to {b} by default. Support {c}.", depth=5),
     "shop", "normal", 14),

    ("rep-passport-appointment", "Passport — Appointment", "gov-form",
     profile_card("Passport Seva", "Appointment details",
                  [("Applicant", G['person']), ("Previous passport", G['passport']),
                   ("Date of birth", G['dob']), ("Aadhaar", G['aadhaar']),
                   ("Present address", G['address']), ("Mobile", G['phone']),
                   ("ARN", G['trap']), ("Slot", G['trap'])],
                  "Bring the originals. {a} is recorded as the emergency contact at {b}. "
                  "Centre code {c}.", depth=6),
     "gov", "compact", 12),
]
