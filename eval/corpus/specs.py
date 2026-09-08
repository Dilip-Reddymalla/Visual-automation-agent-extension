"""The fifty pages.

Twenty-five synthetic archetypes and twenty-five replicas of real Indian portals, banks
and marketplaces. Each function returns a body; `build_corpus` assembles them with a
theme, a density and a font size, and hands the hard negatives round so that every page
carries at least one trap.

Variation is not decoration. A detector tuned on one layout at one font size is tuned on
nothing, and the three axes the brief names -- layout density, font size, text-or-pixels
-- are the ones that actually move the numbers. Where a page is deliberately hostile the
docstring says so and says why, because a page that scores badly for a reason nobody
recorded is a page that gets "fixed" by weakening the corpus.
"""

from __future__ import annotations

import random

import pixels
from pages import (
    Page, bar, buttons, el, esc, field, kv, neg, neg_field, pii, pixel_pii,
    select_field, sidenav, table,
)
from values import Values, hard_negatives


# =============================================================================
# Synthetic: government forms
# =============================================================================


def gov_enrolment(v: Values, n) -> str:
    """An Aadhaar-style enrolment form: every identifier in its own labelled field."""
    name = v.person()
    return f"""
{bar('Unique Identification Authority', '<span class="pill">Enrolment</span>')}
<main>
  <h1>Resident Enrolment / Update</h1>
  <p class="muted">Form 1 &mdash; all fields marked with an asterisk are mandatory.
     Application {neg(*_np(n))}.</p>
  <fieldset><legend>Identity</legend>
    <div class="grid">
      {field('Full name (as on supporting document) *', name, 'PERSON', name='fullName')}
      {field('Date of birth *', v.dob(), 'DOB', name='dob')}
      {field('Aadhaar number *', v.aadhaar(), 'AADHAAR', name='aadhaar',
             hint='Twelve digits, as printed on your existing letter.')}
      {field('PAN', v.pan(), 'PAN', name='pan')}
    </div>
  </fieldset>
  <fieldset><legend>Contact</legend>
    <div class="grid">
      {field('Mobile *', v.phone(), 'PHONE', kind='tel', name='mobile')}
      {field('Email', v.email(name), 'EMAIL', kind='email', name='email')}
    </div>
    {field('Address *', v.address(), 'ADDRESS', name='address')}
  </fieldset>
  <fieldset><legend>Verification</legend>
    {field('Enrolment centre passcode', v.secret(), 'SECRET', kind='password', name='passcode')}
    <p class="hint">Reference {neg(*_np(n))} &mdash; quote this when you call the centre.</p>
  </fieldset>
  {buttons('Save draft', 'Submit')}
</main>"""


def gov_pan_application(v: Values, n) -> str:
    """Form 49A. Dense, three columns, small type -- the hard end of the density axis."""
    name = v.person()
    return f"""
{bar('Income Tax Department', 'Form 49A')}
<div class="crumb">Home &rsaquo; Services &rsaquo; PAN &rsaquo; New application</div>
<main>
  <h1>Application for Allotment of Permanent Account Number</h1>
  <fieldset><legend>Applicant</legend>
    <div class="grid three">
      {field('Surname', name.split()[-1], 'PERSON', name='surname')}
      {field('First name', name.split()[0], 'PERSON', name='first')}
      {field('Date of birth', v.dob(), 'DOB', name='dob')}
      {field('Aadhaar', v.aadhaar(spaced=False), 'AADHAAR', name='aadhaar')}
      {field('Existing PAN, if any', v.pan(), 'PAN', name='pan')}
      {field('Mobile', v.phone(), 'PHONE', kind='tel', name='mobile')}
      {field('Email', v.email(name), 'EMAIL', kind='email', name='email')}
      {field('Father&rsquo;s name', v.person(), 'PERSON', name='father')}
      {select_field('Status', ['Individual', 'HUF', 'Company', 'Firm'])}
    </div>
    {field('Residential address', v.address(), 'ADDRESS', name='address')}
  </fieldset>
  <fieldset><legend>Office use</legend>
    {kv([('Acknowledgement', neg(*_np(n))), ('Fee', 'Rs 107 (inclusive of taxes)'),
         ('Format example', neg(*_np(n)))])}
  </fieldset>
  {buttons('Reset', 'Continue')}
</main>"""


def gov_passport_seva(v: Values, n) -> str:
    """Passport application. Identifiers in read-only summary rows, not fields."""
    name = v.person()
    return f"""
{bar('Passport Seva', 'Application ID ' + neg(*_np(n)))}
<main>
  <h1>Review your application</h1>
  <p class="muted">Check every detail. Once submitted, corrections require a fresh
     appointment.</p>
  <div class="card">
    <h3>Applicant details</h3>
    {kv([
      ('Given name', pii(name.split()[0], 'PERSON')),
      ('Surname', pii(name.split()[-1], 'PERSON')),
      ('Date of birth', pii(v.dob(), 'DOB')),
      ('Previous passport', pii(v.passport(), 'PASSPORT')),
      ('Aadhaar', pii(v.aadhaar(), 'AADHAAR')),
      ('Address', pii(v.address(), 'ADDRESS')),
      ('Mobile', pii(v.phone(), 'PHONE')),
      ('Email', pii(v.email(name), 'EMAIL')),
    ])}
  </div>
  <div class="card">
    <h3>Appointment</h3>
    {kv([('Centre', 'RPO Bengaluru'), ('Slot', neg(*_np(n))),
         ('Helpline', neg(*_np(n)))])}
  </div>
  {buttons('Edit', 'Pay and schedule')}
</main>"""


def gov_ration_card(v: Values, n) -> str:
    """A household table: several people, one row each. Tests per-row PERSON recall."""
    rows = []
    for _ in range(5):
        rows.append([
            pii(v.person(), 'PERSON'),
            pii(v.dob(), 'DOB'),
            pii(v.aadhaar(), 'AADHAAR'),
            'Member',
        ])
    return f"""
{bar('Department of Food and Civil Supplies')}
<main>
  <h1>Ration card &mdash; household members</h1>
  <p class="muted">Card {neg(*_np(n))} &middot; {neg(*_np(n))}</p>
  {table(['Name', 'Date of birth', 'Aadhaar', 'Relation'], rows)}
  <div class="card">
    {field('Head of household mobile', v.phone(), 'PHONE', kind='tel')}
    {neg_field('Fair price shop', *_np(n), prefix='FPS-4412, ')}
  </div>
  {buttons('Print', 'Request update')}
</main>"""


def gov_gst_return(v: Values, n) -> str:
    """GSTR-1 summary. Business identifiers, and an example GSTIN that is a trap."""
    gstin = v.gstin()
    rows = [
        [neg(*_np(n)), '18%', '1,24,000', '22,320'],
        [neg(*_np(n)), '12%', '86,500', '10,380'],
        [neg(*_np(n)), '5%', '2,40,000', '12,000'],
    ]
    return f"""
{bar('Goods and Services Tax Network', pii(gstin, 'GSTIN'))}
<div class="crumb">Returns &rsaquo; GSTR-1 &rsaquo; Outward supplies</div>
<main>
  <h1>Outward supplies &mdash; September</h1>
  <div class="card">
    {kv([('Legal name', pii(v.org(), 'ORG')),
         ('Authorised signatory', pii(v.person(), 'PERSON')),
         ('PAN', pii(v.pan('C'), 'PAN')),
         ('Registered email', pii(v.email(), 'EMAIL')),
         ('Format example', neg(*_np(n)))])}
  </div>
  {table(['Invoice', 'Rate', 'Taxable value', 'Tax'], rows, numeric={2, 3})}
  {buttons('Save', 'File with EVC')}
</main>"""


# =============================================================================
# Synthetic: scholarship applications
# =============================================================================


def scholarship_apply(v: Values, n) -> str:
    name = v.person()
    return f"""
{bar('National Scholarship Portal', 'AY 2026-27')}
<main>
  <div class="cols">
    <div class="side">{sidenav(['Profile', 'Academic', 'Bank', 'Documents', 'Submit'], 2)}</div>
    <div class="pane">
      <h1>Bank details for disbursement</h1>
      <p class="muted">The account must be in the applicant&rsquo;s own name.</p>
      <fieldset><legend>Applicant</legend>
        <div class="grid">
          {field('Name as per bank record', name, 'PERSON')}
          {field('Aadhaar linked to account', v.aadhaar(), 'AADHAAR')}
        </div>
      </fieldset>
      <fieldset><legend>Account</legend>
        <div class="grid">
          {field('Account number', v.account(), 'ACCOUNT')}
          {field('Re-enter account number', v.account(), 'ACCOUNT')}
          {field('IFSC', v.ifsc(), 'IFSC', hint='Example: ' + neg(*_np(n)))}
          {neg_field('Branch', *_np(n), prefix='Jayanagar, ')}
        </div>
      </fieldset>
      {buttons('Back', 'Save and continue')}
    </div>
  </div>
</main>"""


def scholarship_status(v: Values, n) -> str:
    """Status page, roomy, large type. The easy end of the density axis."""
    name = v.person()
    return f"""
{bar('State Merit Scholarship')}
<main>
  <h1>Application status</h1>
  <div class="card">
    <span class="pill">Under verification</span>
    {kv([('Applicant', pii(name, 'PERSON')),
         ('Application no.', neg(*_np(n))),
         ('Aadhaar', pii(v.aadhaar(), 'AADHAAR')),
         ('Registered mobile', pii(v.phone(), 'PHONE')),
         ('Email', pii(v.email(name), 'EMAIL')),
         ('Submitted', neg(*_np(n)))])}
  </div>
  <div class="card">
    <h3>What happens next</h3>
    <p>Your institution will verify the documents you uploaded. You will be told at
       {pii(v.email(name), 'EMAIL')} when that is done. For queries call
       {neg(*_np(n))}.</p>
  </div>
  {buttons('Download receipt', 'Track again')}
</main>"""


def scholarship_documents(v: Values, n) -> str:
    """Uploads. PII is in the file names, which is a place teams routinely forget."""
    name = v.person()
    slug = name.lower().replace(' ', '_')
    rows = [
        [f'{slug}_aadhaar.pdf', pii(v.aadhaar(), 'AADHAAR'), 'Verified'],
        [f'{slug}_marksheet.pdf', neg(*_np(n)), 'Verified'],
        [f'{slug}_income.pdf', neg(*_np(n)), 'Pending'],
        [f'{slug}_bank.pdf', pii(v.account(), 'ACCOUNT'), 'Verified'],
    ]
    return f"""
{bar('National Scholarship Portal', 'Documents')}
<main>
  <h1>Uploaded documents</h1>
  <p class="muted">Uploaded by {pii(name, 'PERSON')} &middot; {pii(v.email(name), 'EMAIL')}</p>
  {table(['File', 'Identifier on document', 'Status'], rows)}
  <div class="card">
    <label>Replace a document</label>
    <input type="file" {el()} />
    {buttons('Upload')}
  </div>
</main>"""


# =============================================================================
# Synthetic: bank statements
# =============================================================================


def bank_statement(v: Values, n) -> str:
    """A statement: account identifiers in a header, amounts in a ruled table.

    The amounts are the point. Currency grouped in fours is what a card-shaped regex
    without a checksum eats, and there are three of them here.
    """
    name = v.person()
    rows = [
        ['01 Sep', 'UPI/' + pii(v.upi(), 'UPI') + '/Rent', '', '18,000', '64,220'],
        ['03 Sep', 'NEFT ' + neg(*_np(n)), '42,000', '', '1,06,220'],
        ['07 Sep', 'POS ' + neg(*_np(n)), '', '2,340', '1,03,880'],
        ['11 Sep', 'IMPS to ' + pii(v.person(), 'PERSON'), '', '7,500', '96,380'],
        ['14 Sep', 'Salary ' + pii(v.org(), 'ORG'), '78,400', '', '1,74,780'],
        ['19 Sep', 'Card ' + neg(*_np(n)), '', '1,299', '1,73,481'],
    ]
    return f"""
{bar('Canara Co-operative Bank', 'Statement')}
<main>
  <h1>Account statement &mdash; September</h1>
  <div class="card">
    {kv([('Account holder', pii(name, 'PERSON')),
         ('Account number', pii(v.account(), 'ACCOUNT')),
         ('IFSC', pii(v.ifsc(), 'IFSC')),
         ('Registered address', pii(v.address(), 'ADDRESS')),
         ('Statement period', neg(*_np(n)))])}
  </div>
  {table(['Date', 'Narration', 'Credit', 'Debit', 'Balance'], rows, numeric={2, 3, 4})}
  {buttons('Email statement', 'Download PDF')}
</main>"""


def bank_transfer(v: Values, n) -> str:
    """A transfer form: a saved-payee list plus a live form. Compact, small type."""
    payees = [
        [pii(v.person(), 'PERSON'), pii(v.account(), 'ACCOUNT'), pii(v.ifsc(), 'IFSC')],
        [pii(v.person(), 'PERSON'), pii(v.account(), 'ACCOUNT'), pii(v.ifsc(), 'IFSC')],
        [pii(v.org(), 'ORG'), pii(v.account(), 'ACCOUNT'), neg(*_np(n))],
    ]
    return f"""
{bar('NetBanking', 'Logged in as ' + pii(v.person(), 'PERSON'))}
<main>
  <div class="cols">
    <div class="side">{sidenav(['Accounts', 'Transfer', 'Bills', 'Cards', 'Profile'], 1)}</div>
    <div class="pane">
      <h1>Transfer funds</h1>
      <h3>Saved payees</h3>
      {table(['Payee', 'Account', 'IFSC'], payees)}
      <fieldset><legend>New payee</legend>
        <div class="grid">
          {field('Payee name', '', 'PERSON')}
          {field('Account number', '', 'ACCOUNT')}
          {field('IFSC', '', 'IFSC', hint='Example ' + neg(*_np(n)))}
          {field('Amount', '', None)}
        </div>
        {field('Transaction password', '', 'SECRET', kind='password')}
      </fieldset>
      {buttons('Cancel', 'Transfer')}
    </div>
  </div>
</main>"""


def bank_card_statement(v: Values, n) -> str:
    """A credit-card statement. Real card numbers beside sixteen-digit decoys."""
    card = v.card()
    rows = [
        ['02 Sep', 'AMAZON RETAIL', neg(*_np(n)), '3,499'],
        ['05 Sep', 'INDIAN OIL', neg(*_np(n)), '2,000'],
        ['12 Sep', 'MYNTRA', neg(*_np(n)), '1,860'],
    ]
    return f"""
{bar('Card Services', 'Statement')}
<main>
  <h1>Credit card statement</h1>
  <div class="card">
    {kv([('Cardholder', pii(v.person(), 'PERSON')),
         ('Card number', pii(card, 'CARD')),
         ('Billing address', pii(v.address(), 'ADDRESS')),
         ('Due date', neg(*_np(n))),
         ('Total due', 'Rs 7,359.00')])}
  </div>
  {table(['Date', 'Merchant', 'Reference', 'Amount'], rows, numeric={3})}
  <p class="hint">Payments to {pii(v.upi(), 'UPI')} are credited the same day.
     Amount in words: {neg(*_np(n))}.</p>
  {buttons('Pay minimum', 'Pay total')}
</main>"""


# =============================================================================
# Synthetic: scanned identity documents (PII as pixels)
# =============================================================================


def scan_id_card(v: Values, n) -> str:
    """A scanned Aadhaar letter. Nothing readable is in the DOM.

    This page is where the recall number is supposed to look bad today. L0 and L1 read
    the DOM and there is nothing in it; the identifiers are in a PNG. It is scored in its
    own bucket so it says "L3 is not built yet" rather than depressing a number that
    measures the deterministic layers.
    """
    name = v.person()
    uri = pixels.id_card(name, v.aadhaar(), v.dob(), v.address())
    return f"""
{bar('DigiLocker', 'Issued documents')}
<main>
  <h1>Aadhaar &mdash; issued document</h1>
  <p class="muted">Issued by UIDAI &middot; {neg(*_np(n))}</p>
  <div class="scanwrap">
    {pixel_pii(uri, 'AADHAAR', 460, 280, alt='Scanned identity document')}
  </div>
  <p class="hint">This document is fetched from the issuer each time it is shown.
     Reference {neg(*_np(n))}.</p>
  {buttons('Share', 'Download')}
</main>"""


def scan_cheque(v: Values, n) -> str:
    """A cancelled cheque uploaded to prove an account. Account and IFSC are pixels."""
    name = v.person()
    uri = pixels.cheque(name, v.account(), v.ifsc(), 'Twenty five thousand only')
    return f"""
{bar('Vendor Onboarding', 'Step 3 of 4')}
<main>
  <h1>Cancelled cheque</h1>
  <p class="muted">Uploaded for {pii(name, 'PERSON')} &middot; {neg(*_np(n))}</p>
  <div class="scanwrap">
    {pixel_pii(uri, 'ACCOUNT', 620, 240, alt='Cancelled cheque')}
  </div>
  <div class="card">
    {field('Confirm account number', '', 'ACCOUNT',
           hint='Must match the cheque above.')}
    {field('Confirm IFSC', '', 'IFSC')}
  </div>
  {buttons('Re-upload', 'Confirm')}
</main>"""


def scan_receipt(v: Values, n) -> str:
    """A photographed invoice beside a typed summary: the same identifiers, twice."""
    gstin = v.gstin()
    pan = v.pan('C')
    uri = pixels.receipt([
        ('GSTIN', gstin), ('PAN', pan), ('Invoice', '2026/0912'),
        ('Amount', 'Rs 1,24,000'), ('Signatory', v.person()),
    ])
    return f"""
{bar('Expense Claims', 'Claim ' + neg(*_np(n)))}
<main>
  <h1>Attached invoice</h1>
  <div class="cols">
    <div class="pane">
      <div class="scanwrap">{pixel_pii(uri, 'GSTIN', 340, 300, alt='Scanned invoice')}</div>
    </div>
    <div class="rail">
      <div class="card">
        <h3>What we read from it</h3>
        {kv([('GSTIN', pii(gstin, 'GSTIN')), ('PAN', pii(pan, 'PAN')),
             ('Invoice', neg(*_np(n))), ('Amount', 'Rs 1,24,000')])}
        <p class="hint">Correct anything the scan got wrong.</p>
      </div>
      {buttons('Reject', 'Approve')}
    </div>
  </div>
</main>"""


def scan_signature_form(v: Values, n) -> str:
    """A form ending in a signature image: a region for the blur path, not a mask."""
    name = v.person()
    return f"""
{bar('Insurance Nominee Update')}
<main>
  <h1>Nominee declaration</h1>
  <fieldset><legend>Policyholder</legend>
    <div class="grid">
      {field('Name', name, 'PERSON')}
      {neg_field('Policy number', *_np(n))}
      {field('Date of birth', v.dob(), 'DOB')}
      {field('PAN', v.pan(), 'PAN')}
    </div>
  </fieldset>
  <fieldset><legend>Nominee</legend>
    <div class="grid">
      {field('Nominee name', v.person(), 'PERSON')}
      {field('Nominee date of birth', v.dob(), 'DOB')}
      {field('Nominee Aadhaar', v.aadhaar(), 'AADHAAR')}
      {field('Relationship', 'Spouse', None)}
    </div>
  </fieldset>
  <div class="card">
    {pixel_pii(pixels.signature(name), 'PERSON', 240, 90, alt='Signature')}
  </div>
  {buttons('Save', 'Submit declaration')}
</main>"""


# =============================================================================
# Synthetic: healthcare
# =============================================================================


def health_portal(v: Values, n) -> str:
    name = v.person()
    rows = [
        ['12 Aug', 'Haemogram', 'Dr ' + pii(v.person(), 'PERSON'), 'Ready'],
        ['02 Sep', 'Lipid profile', 'Dr ' + pii(v.person(), 'PERSON'), 'Ready'],
        ['21 Sep', 'HbA1c', 'Dr ' + pii(v.person(), 'PERSON'), 'Collected'],
    ]
    return f"""
{bar('Apex Hospitals', 'Patient portal')}
<main>
  <div class="cols">
    <div class="side">{sidenav(['Overview', 'Reports', 'Appointments', 'Billing'], 1)}</div>
    <div class="pane">
      <h1>Reports</h1>
      <div class="card">
        {kv([('Patient', pii(name, 'PERSON')),
             ('UHID', neg(*_np(n))),
             ('Date of birth', pii(v.dob(), 'DOB')),
             ('Mobile', pii(v.phone(), 'PHONE')),
             ('Address', pii(v.address(), 'ADDRESS')),
             ('Insurer ID', pii(v.account(), 'ACCOUNT'))])}
      </div>
      {table(['Date', 'Investigation', 'Referred by', 'Status'], rows)}
      {buttons('Book a test', 'Download all')}
    </div>
  </div>
</main>"""


def health_appointment(v: Values, n) -> str:
    """Appointment booking. PII in inputs that carry no <label> at all."""
    name = v.person()
    return f"""
{bar('Practo-style Booking')}
<main>
  <h1>Book an appointment</h1>
  <p class="muted">Dr {pii(v.person(), 'PERSON')} &middot; General medicine &middot;
     {neg(*_np(n))}</p>
  <div class="card">
    <!-- No <label> anywhere below. The accessible name comes from placeholder alone,
         which is exactly how a great many real booking forms are built. -->
    <div class="f"><input type="text" placeholder="Patient name" value="{esc(name)}"
        {el()} data-pii="PERSON" /></div>
    <div class="f"><input type="tel" placeholder="Mobile number" value="{esc(v.phone())}"
        {el()} data-pii="PHONE" /></div>
    <div class="f"><input type="email" placeholder="Email (optional)"
        value="{esc(v.email(name))}" {el()} data-pii="EMAIL" /></div>
    <div class="f"><input type="text" placeholder="Date of birth"
        value="{esc(v.dob())}" {el()} data-pii="DOB" /></div>
    <div class="f"><input type="text" placeholder="Insurance member ID"
        value="{esc(v.account())}" {el()} data-pii="ACCOUNT" /></div>
    {buttons('Confirm booking')}
  </div>
  <p class="hint">Cancellations up to {neg(*_np(n))}.</p>
</main>"""


def health_discharge(v: Values, n) -> str:
    """A discharge summary: running prose with identifiers buried inside sentences.

    Deliberately hostile, and the reason is recorded rather than smoothed away. The
    walker gives a text run the *containing element's* rectangle (perceive.ts,
    textRuns), so an Aadhaar inside a long paragraph is reported at the paragraph's box.
    Its ground truth here is the glyphs, so this page is where over-redaction on running
    text becomes visible and measurable instead of merely suspected.
    """
    name = v.person()
    return f"""
{bar('Apex Hospitals', 'Discharge summary')}
<main>
  <h1>Discharge summary</h1>
  <div class="card">
    <p>{pii(name, 'PERSON')}, {pii(v.dob(), 'DOB')}, resident of
       {pii(v.address(), 'ADDRESS')}, was admitted on {neg(*_np(n))} and discharged
       today. The insurer was billed against member number
       {pii(v.account(), 'ACCOUNT')} and the claim reference is {neg(*_np(n))}.</p>
    <p>Follow-up has been arranged; the appointment reminder will be sent to
       {pii(v.phone(), 'PHONE')} and copied to {pii(v.email(name), 'EMAIL')}. The
       treating consultant was Dr {pii(v.person(), 'PERSON')}. Identity was verified
       against Aadhaar {pii(v.aadhaar(), 'AADHAAR')} at admission.</p>
  </div>
  {buttons('Print', 'Email to me')}
</main>"""


# =============================================================================
# Synthetic: job application
# =============================================================================


def job_application(v: Values, n) -> str:
    name = v.person()
    return f"""
{bar('Careers', 'Software Engineer, Intern')}
<main>
  <h1>Apply</h1>
  <fieldset><legend>About you</legend>
    <div class="grid">
      {field('Full name', name, 'PERSON')}
      {field('Email', v.email(name), 'EMAIL', kind='email',
             hint='We will only use this to contact you. Example: ' + neg(*_np(n)))}
      {field('Phone', v.phone(), 'PHONE', kind='tel')}
      {neg_field('Current city', *_np(n))}
      {field('PAN (for offer paperwork)', v.pan(), 'PAN')}
      {field('LinkedIn', 'linkedin.example/in/' + name.lower().replace(' ', '-'), 'PERSON')}
    </div>
    {field('Address', v.address(), 'ADDRESS')}
  </fieldset>
  <fieldset><legend>Attachments</legend>
    <div class="f"><label>Resume</label><input type="file" {el()} /></div>
    <div class="f"><label>Cover note</label>
      <textarea rows="3" {el()}>Reachable on {esc(v.phone())} at short notice.</textarea></div>
  </fieldset>
  {buttons('Save', 'Submit application')}
</main>"""


def job_profile(v: Values, n) -> str:
    """A candidate profile page, roomy and large-type."""
    name = v.person()
    return f"""
{bar('Talent Network', 'Profile')}
<main>
  <h1>{pii(name, 'PERSON')}</h1>
  <p class="muted">{neg(*_np(n))} &middot; open to work</p>
  <div class="card">
    <h3>Contact</h3>
    {kv([('Email', pii(v.email(name), 'EMAIL')),
         ('Phone', pii(v.phone(), 'PHONE')),
         ('Location', neg(*_np(n))),
         ('Passport', pii(v.passport(), 'PASSPORT'))])}
  </div>
  <div class="card">
    <h3>Experience</h3>
    <p><strong>{pii(v.org(), 'ORG')}</strong> &mdash; Engineer, {neg(*_np(n))} to present.
       Reported to {pii(v.person(), 'PERSON')}.</p>
  </div>
  {buttons('Message', 'Shortlist')}
</main>"""


def job_offer(v: Values, n) -> str:
    """An offer acceptance page: salary account details, and a password field."""
    name = v.person()
    return f"""
{bar('Onboarding', 'Offer ' + neg(*_np(n)))}
<main>
  <h1>Accept your offer</h1>
  <div class="card">
    {kv([('Candidate', pii(name, 'PERSON')),
         ('Date of birth', pii(v.dob(), 'DOB')),
         ('PAN', pii(v.pan(), 'PAN')),
         ('Aadhaar', pii(v.aadhaar(), 'AADHAAR')),
         ('Offer valid till', neg(*_np(n)))])}
  </div>
  <fieldset><legend>Salary account</legend>
    <div class="grid">
      {field('Account number', v.account(), 'ACCOUNT')}
      {field('IFSC', v.ifsc(), 'IFSC')}
      {field('UPI for reimbursements', v.upi(), 'UPI')}
      {field('Portal password', '', 'SECRET', kind='password')}
    </div>
  </fieldset>
  {buttons('Decline', 'Accept offer')}
</main>"""


# =============================================================================
# Synthetic: e-commerce checkout
# =============================================================================


def shop_checkout(v: Values, n) -> str:
    name = v.person()
    return f"""
{bar('Bazaar', 'Checkout')}
<main>
  <div class="cols">
    <div class="pane">
      <h1>Delivery address</h1>
      <div class="card">
        {field('Full name', name, 'PERSON')}
        {field('Address', v.address(), 'ADDRESS')}
        {field('Mobile', v.phone(), 'PHONE', kind='tel')}
      </div>
      <h2>Payment</h2>
      <div class="card">
        {field('Card number', v.card(), 'CARD')}
        <div class="grid">
          {field('Expiry', '09/29', None)}
          {field('CVV', '', 'SECRET', kind='password')}
        </div>
        {field('Or pay by UPI', v.upi(), 'UPI')}
      </div>
    </div>
    <div class="rail">
      <div class="card">
        <h3>Order summary</h3>
        {kv([('Order', neg(*_np(n))), ('Items', '3'),
             ('Total', neg(*_np(n))), ('Delivery by', neg(*_np(n)))])}
        {buttons('Place order')}
      </div>
    </div>
  </div>
</main>"""


def shop_order_detail(v: Values, n) -> str:
    """An order page: identifiers everywhere, almost all of them not PII."""
    name = v.person()
    rows = [
        ['Steel water bottle', neg(*_np(n)), 'Delivered', '649'],
        ['USB-C cable, 2 m', neg(*_np(n)), 'Delivered', '399'],
        ['Notebook, ruled', neg(*_np(n)), 'Out for delivery', '120'],
    ]
    return f"""
{bar('Bazaar', 'Your orders')}
<main>
  <h1>Order details</h1>
  <p class="muted">{neg(*_np(n))} &middot; placed {neg(*_np(n))}</p>
  {table(['Item', 'Tracking', 'Status', 'Price'], rows, numeric={3})}
  <div class="card">
    <h3>Shipping to</h3>
    <p>{pii(name, 'PERSON')}<br />{pii(v.address(), 'ADDRESS')}<br />
       {pii(v.phone(), 'PHONE')}</p>
  </div>
  <div class="card">
    <h3>Paid with</h3>
    <p>Card ending {pii(v.card()[-4:], 'CARD')} &middot; UPI {pii(v.upi(), 'UPI')}</p>
  </div>
  {buttons('Return', 'Buy again')}
</main>"""


def shop_address_book(v: Values, n) -> str:
    """Several saved addresses, each a card. Tests recall when the same class repeats."""
    cards = ""
    for label in ['Home', 'Office', 'Parents']:
        cards += f"""<div class="card">
          <span class="pill">{label}</span>
          <p>{pii(v.person(), 'PERSON')}<br />{pii(v.address(), 'ADDRESS')}<br />
             {pii(v.phone(), 'PHONE')}</p>
          {buttons('Edit', 'Delete', primary_last=False)}
        </div>"""
    return f"""
{bar('Bazaar', 'Addresses')}
<main>
  <h1>Saved addresses</h1>
  <p class="muted">Default delivery slot {neg(*_np(n))}</p>
  {cards}
  {buttons('Add a new address')}
</main>"""


# =============================================================================
# Synthetic: insurance claim
# =============================================================================


def insurance_claim(v: Values, n) -> str:
    name = v.person()
    return f"""
{bar('Sampoorna General Insurance', 'Claim intimation')}
<main>
  <h1>Intimate a claim</h1>
  <fieldset><legend>Policy</legend>
    <div class="grid">
      {neg_field('Policy number', *_np(n))}
      {field('Policyholder', name, 'PERSON')}
      {field('Date of birth', v.dob(), 'DOB')}
      {field('Registered mobile', v.phone(), 'PHONE', kind='tel')}
    </div>
  </fieldset>
  <fieldset><legend>Incident</legend>
    {neg_field('Date of incident', *_np(n))}
    <div class="f"><label>What happened</label>
      <textarea rows="3" {el()}>Vehicle {esc(v.licence())} was damaged in the
        parking area.</textarea></div>
  </fieldset>
  <fieldset><legend>Settlement</legend>
    <div class="grid">
      {field('Account number', v.account(), 'ACCOUNT')}
      {field('IFSC', v.ifsc(), 'IFSC')}
      {field('PAN', v.pan(), 'PAN')}
      {field('Driving licence', v.licence(), 'LICENCE')}
    </div>
  </fieldset>
  {buttons('Save draft', 'Intimate claim')}
</main>"""


def insurance_status(v: Values, n) -> str:
    rows = [
        [neg(*_np(n)), 'Documents received', neg(*_np(n)), '—'],
        [neg(*_np(n)), 'Surveyor assigned', neg(*_np(n)), 'Dr ' + pii(v.person(), 'PERSON')],
        [neg(*_np(n)), 'Approved', neg(*_np(n)), 'Rs 48,200'],
    ]
    return f"""
{bar('Sampoorna General Insurance', 'Claim status')}
<main>
  <h1>Claim progress</h1>
  <div class="card">
    {kv([('Claimant', pii(v.person(), 'PERSON')),
         ('Policy', neg(*_np(n))),
         ('Settlement account', pii(v.account(), 'ACCOUNT')),
         ('IFSC', pii(v.ifsc(), 'IFSC')),
         ('Contact', pii(v.phone(), 'PHONE'))])}
  </div>
  {table(['Stage', 'Event', 'On', 'Note'], rows)}
  {buttons('Raise a query', 'Download letter')}
</main>"""


def insurance_health_card(v: Values, n) -> str:
    """A health insurance card: pixels for the card, DOM for the summary beside it."""
    name = v.person()
    uri = pixels.id_card(
        name, v.account(), v.dob(), v.address(),
        title='SAMPOORNA HEALTH', subtitle='Cashless network card',
        tint=(240, 247, 252),
    )
    return f"""
{bar('Sampoorna General Insurance', 'Health card')}
<main>
  <h1>Your cashless card</h1>
  <div class="cols">
    <div class="pane"><div class="scanwrap">
      {pixel_pii(uri, 'ACCOUNT', 460, 280, alt='Health insurance card')}
    </div></div>
    <div class="rail"><div class="card">
      <h3>On file</h3>
      {kv([('Member', pii(name, 'PERSON')),
           ('Valid till', neg(*_np(n))),
           ('Mobile', pii(v.phone(), 'PHONE')),
           ('Helpline', neg(*_np(n)))])}
    </div></div>
  </div>
  {buttons('Add dependant', 'Download card')}
</main>"""


SYNTHETIC = [
    ("syn-gov-enrolment", "Aadhaar Enrolment / Update", "gov-form", gov_enrolment, "gov", "normal", 15),
    ("syn-gov-pan-49a", "Form 49A — PAN Application", "gov-form", gov_pan_application, "gov", "compact", 12),
    ("syn-gov-passport", "Passport Seva — Review", "gov-form", gov_passport_seva, "gov", "roomy", 17),
    ("syn-gov-gstr1", "GSTR-1 — Outward Supplies", "gov-form", gov_gst_return, "gov", "normal", 14),
    ("syn-sch-apply", "Scholarship — Bank Details", "scholarship", scholarship_apply, "portal", "normal", 15),
    ("syn-sch-status", "Scholarship — Status", "scholarship", scholarship_status, "portal", "roomy", 18),
    ("syn-sch-docs", "Scholarship — Documents", "scholarship", scholarship_documents, "portal", "compact", 13),
    ("syn-bank-statement", "Account Statement", "bank-statement", bank_statement, "bank", "compact", 13),
    ("syn-bank-transfer", "NetBanking — Transfer", "bank-statement", bank_transfer, "bank", "compact", 12),
    ("syn-bank-card", "Credit Card Statement", "bank-statement", bank_card_statement, "bank", "normal", 14),
    ("syn-scan-aadhaar", "DigiLocker — Aadhaar", "scanned-id", scan_id_card, "scan", "roomy", 16),
    ("syn-scan-cheque", "Vendor Onboarding — Cheque", "scanned-id", scan_cheque, "scan", "normal", 15),
    ("syn-scan-invoice", "Expense Claim — Invoice", "scanned-id", scan_receipt, "scan", "normal", 14),
    ("syn-scan-signature", "Nominee Declaration", "scanned-id", scan_signature_form, "scan", "normal", 15),
    ("syn-health-portal", "Hospital — Reports", "healthcare", health_portal, "health", "normal", 14),
    ("syn-health-booking", "Appointment Booking", "healthcare", health_appointment, "health", "roomy", 16),
    ("syn-health-discharge", "Discharge Summary", "healthcare", health_discharge, "health", "normal", 15),
    ("syn-job-apply", "Job Application", "job-application", job_application, "portal", "normal", 15),
    ("syn-job-offer", "Accept Your Offer", "job-application", job_offer, "portal", "normal", 14),
    ("syn-shop-checkout", "Checkout", "ecommerce", shop_checkout, "shop", "normal", 15),
    ("syn-shop-order", "Order Details", "ecommerce", shop_order_detail, "shop", "compact", 13),
    ("syn-shop-addresses", "Saved Addresses", "ecommerce", shop_address_book, "shop", "roomy", 16),
    ("syn-ins-claim", "Intimate a Claim", "insurance", insurance_claim, "portal", "compact", 13),
    ("syn-ins-status", "Claim Status", "insurance", insurance_status, "portal", "normal", 14),
    ("syn-ins-card", "Cashless Health Card", "insurance", insurance_health_card, "health", "normal", 15),
]
# gov_ration_card and job_profile are used by the replica half (replicas.py): both are
# closer in shape to the real portals they stand in for than to the clean archetypes
# here, and duplicating them would only add a page that scores the same twice.


def _np(n) -> tuple[str, str, str]:
    """Take the next hard negative, as (text, looksLike, why) for `neg()`."""
    item = next(n)
    return item["text"], item["looksLike"], item["why"]
