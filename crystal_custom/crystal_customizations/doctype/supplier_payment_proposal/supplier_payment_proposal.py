# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt

import erpnext
import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cstr, flt, getdate, now_datetime, nowdate

# Row fields copied from the Purchase Invoice on every save.
INVOICE_ROW_FIELDS = (
	"supplier",
	"supplier_name",
	"bill_no",
	"posting_date",
	"due_date",
	"currency",
	"party_account",
	"grand_total",
	"outstanding_amount",
)


class SupplierPaymentProposal(Document):
	def validate(self):
		self.validate_paid_from()
		self.validate_invoices()
		self.set_totals()
		self.validate_rejection_reason()

	def before_submit(self):
		# Submit is driven by the workflow's "Approve" action.
		self.approved_by = frappe.session.user
		self.approved_on = now_datetime()

	def before_cancel(self):
		linked = [row.payment_entry for row in self.invoices if row.payment_entry]
		if linked:
			frappe.throw(
				_("Cancel or delete these Payment Entries first: {0}").format(
					", ".join(frappe.bold(name) for name in linked)
				),
				title=_("Cancellation Blocked"),
			)

	# ------------------------------------------------------------------
	# Validation
	# ------------------------------------------------------------------
	def validate_paid_from(self):
		account = frappe.db.get_value(
			"Account",
			self.paid_from,
			["company", "is_group", "account_type", "account_currency"],
			as_dict=True,
		)
		if account.company != self.company:
			frappe.throw(_("Account {0} does not belong to {1}.").format(self.paid_from, self.company))
		if account.is_group or account.account_type not in ("Bank", "Cash"):
			frappe.throw(_("Pay From must be a Bank or Cash ledger account, not a group."))

		self.paid_from_account_currency = account.account_currency

	def validate_invoices(self):
		seen = set()
		for row in self.invoices:
			if row.purchase_invoice in seen:
				frappe.throw(
					_("Row #{0}: Purchase Invoice {1} is listed more than once.").format(
						row.idx, frappe.bold(row.purchase_invoice)
					)
				)
			seen.add(row.purchase_invoice)

			# Always work from the invoice's current outstanding, not what was
			# loaded when the row was added.
			details = get_invoice_details(row.purchase_invoice, check_permission=False)
			row.update({field: details[field] for field in INVOICE_ROW_FIELDS})

			error = get_invoice_error(details, self.company, self.paid_from_account_currency)
			if error:
				frappe.throw(_("Row #{0}: {1}").format(row.idx, error))

			if not flt(row.amount_to_pay):
				row.amount_to_pay = row.outstanding_amount

			if flt(row.amount_to_pay) < 0 or flt(row.amount_to_pay) > flt(row.outstanding_amount):
				frappe.throw(
					_("Row #{0}: Amount to Pay for {1} must be between 0 and the outstanding {2}.").format(
						row.idx,
						frappe.bold(row.purchase_invoice),
						frappe.format_value(row.outstanding_amount, {"fieldtype": "Currency"}),
					)
				)

		self.validate_not_in_other_proposals()

	def validate_not_in_other_proposals(self):
		clashes = get_invoices_in_open_proposals([row.purchase_invoice for row in self.invoices], self.name)
		if clashes:
			frappe.throw(
				"<br>".join(
					_("{0} is already in open proposal {1}.").format(
						frappe.bold(invoice), frappe.bold(proposal)
					)
					for invoice, proposal in clashes.items()
				),
				title=_("Invoice Already Proposed"),
			)

	def validate_rejection_reason(self):
		if self.get("workflow_state") == "Rejected" and not (self.rejection_reason or "").strip():
			frappe.throw(_("Please enter a Rejection Reason before rejecting this proposal."))

	def set_totals(self):
		self.total_amount = sum(flt(row.amount_to_pay) for row in self.invoices)
		self.invoice_count = len(self.invoices)
		self.supplier_count = len({row.supplier for row in self.invoices})

	# ------------------------------------------------------------------
	# Payment Entries
	# ------------------------------------------------------------------
	@frappe.whitelist()
	def create_payment_entries(self):
		if self.docstatus != 1:
			frappe.throw(_("Payment Entries can only be created once the proposal is approved."))
		frappe.has_permission("Payment Entry", "create", throw=True)

		# One Payment Entry per supplier (and payable account, in the rare case
		# a supplier's invoices are booked to different creditors accounts).
		groups = {}
		for row in self.invoices:
			if not row.payment_entry:
				groups.setdefault((row.supplier, row.party_account), []).append(row)

		if not groups:
			frappe.throw(_("Payment Entries have already been created for every invoice."))

		created, failed = [], []
		for rows in groups.values():
			frappe.db.savepoint("supplier_payment_proposal")
			try:
				pe = self.make_payment_entry(rows)
			except Exception as e:
				frappe.db.rollback(save_point="supplier_payment_proposal")
				frappe.clear_last_message()
				failed.append({"supplier": rows[0].supplier, "error": cstr(e)})
				continue

			for row in rows:
				row.db_set("payment_entry", pe.name, update_modified=False)
			created.append({"supplier": rows[0].supplier, "payment_entry": pe.name, "amount": pe.paid_amount})

		self.update_payment_status()
		return {"created": created, "failed": failed}

	def make_payment_entry(self, rows):
		from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

		pe = None
		for row in rows:
			# Let ERPNext build the references (it splits by payment terms when
			# the invoice's template requires it), then trim them to the
			# approved amount.
			source = get_payment_entry(
				"Purchase Invoice",
				row.purchase_invoice,
				bank_account=self.paid_from,
				reference_date=self.payment_date,
			)
			references = allocate_references(source.references, row)

			if pe is None:
				pe = source
				pe.set("references", [])
			pe.extend("references", references)

		total = sum(flt(row.amount_to_pay) for row in rows)

		pe.posting_date = self.payment_date
		pe.reference_date = self.payment_date
		# Placeholder: Accounts replaces this with the cheque / EFT number before submitting.
		pe.reference_no = self.name
		pe.mode_of_payment = self.mode_of_payment
		pe.paid_from = self.paid_from
		pe.paid_from_account_currency = self.paid_from_account_currency
		pe.paid_from_account_type = frappe.db.get_value("Account", self.paid_from, "account_type")
		pe.bank_account = frappe.db.get_value(
			"Bank Account", {"account": self.paid_from, "is_company_account": 1}, "name"
		)
		# Pay exactly what was approved: no early-payment discounts.
		pe.set("deductions", [])
		pe.paid_amount = pe.received_amount = total
		pe.custom_supplier_payment_proposal = self.name

		pe.set_exchange_rate()
		pe.set_amounts()
		pe.insert()

		return pe

	def update_payment_status(self):
		entries = [row.payment_entry for row in self.invoices if row.payment_entry]
		submitted = set(
			frappe.get_all(
				"Payment Entry",
				filters={"name": ("in", entries), "docstatus": 1},
				pluck="name",
			)
			if entries
			else []
		)

		if not entries:
			status = "Pending"
		elif len(entries) < len(self.invoices):
			status = "Partly Created"
		elif submitted.issuperset(entries):
			status = "Paid"
		else:
			status = "Created"

		self.db_set("payment_status", status, update_modified=False)


def allocate_references(references, row):
	"""Spread the approved amount over the invoice's references, earliest first."""
	remaining = flt(row.amount_to_pay)
	allocated = []

	for ref in references:
		if remaining <= 0:
			break
		amount = min(flt(ref.allocated_amount), remaining)
		if amount <= 0:
			continue

		values = ref.as_dict(no_default_fields=True)
		values.allocated_amount = amount
		allocated.append(values)
		remaining -= amount

	if flt(remaining, 2) > 0:
		frappe.throw(
			_("{0} no longer has {1} outstanding. Refresh the proposal and approve it again.").format(
				frappe.bold(row.purchase_invoice),
				frappe.format_value(row.amount_to_pay, {"fieldtype": "Currency"}),
			)
		)

	return allocated


# ----------------------------------------------------------------------
# Invoice lookups
# ----------------------------------------------------------------------
@frappe.whitelist()
def get_invoice_details(purchase_invoice, check_permission=True):
	if check_permission:
		frappe.has_permission("Purchase Invoice", "read", doc=purchase_invoice, throw=True)

	pi = frappe.db.get_value(
		"Purchase Invoice",
		purchase_invoice,
		[
			"name",
			"docstatus",
			"company",
			"supplier",
			"supplier_name",
			"bill_no",
			"posting_date",
			"due_date",
			"is_return",
			"on_hold",
			"release_date",
			"credit_to",
			"party_account_currency",
			"base_rounded_total",
			"base_grand_total",
			"rounded_total",
			"grand_total",
			"outstanding_amount",
		],
		as_dict=True,
	)
	if not pi:
		frappe.throw(_("Purchase Invoice {0} does not exist.").format(purchase_invoice))

	if pi.party_account_currency == erpnext.get_company_currency(pi.company):
		grand_total = pi.base_rounded_total or pi.base_grand_total
	else:
		grand_total = pi.rounded_total or pi.grand_total

	pi.update(
		{
			"purchase_invoice": pi.name,
			"currency": pi.party_account_currency,
			"party_account": pi.credit_to,
			"grand_total": grand_total,
			"amount_to_pay": pi.outstanding_amount,
		}
	)
	return pi


def get_invoice_error(pi, company, currency):
	"""Return why this invoice can't go on a proposal, or None."""
	if pi.docstatus != 1:
		return _("{0} is not submitted.").format(frappe.bold(pi.name))
	if pi.company != company:
		return _("{0} belongs to {1}.").format(frappe.bold(pi.name), pi.company)
	if pi.is_return:
		return _("{0} is a debit note and cannot be paid.").format(frappe.bold(pi.name))
	if flt(pi.outstanding_amount) <= 0:
		return _("{0} has nothing outstanding.").format(frappe.bold(pi.name))
	if pi.on_hold and (not pi.release_date or getdate(pi.release_date) > getdate(nowdate())):
		return _("{0} is on hold.").format(frappe.bold(pi.name))
	if currency and pi.party_account_currency != currency:
		return _("{0} is in {1} but the Pay From account is in {2}.").format(
			frappe.bold(pi.name), pi.party_account_currency, currency
		)
	if is_supplier_blocked_for_payment(pi.supplier):
		return _("Supplier {0} is on hold for payments.").format(frappe.bold(pi.supplier))


def is_supplier_blocked_for_payment(supplier):
	hold = frappe.get_cached_value("Supplier", supplier, ["on_hold", "hold_type", "release_date"], as_dict=True)
	return bool(
		hold.on_hold
		and hold.hold_type in ("All", "Payments")
		and (not hold.release_date or getdate(hold.release_date) > getdate(nowdate()))
	)


def get_invoices_in_open_proposals(invoices, exclude_proposal=None):
	"""Map invoice -> proposal for invoices still waiting on another proposal.

	An invoice is "waiting" until its Payment Entry from that proposal is
	submitted. Rejected and cancelled proposals don't count.
	"""
	if not invoices:
		return {}

	conditions = ""
	if frappe.get_meta("Supplier Payment Proposal").has_field("workflow_state"):
		conditions = "and ifnull(p.workflow_state, '') != 'Rejected'"

	rows = frappe.db.sql(
		f"""
		select i.purchase_invoice, p.name
		from `tabSupplier Payment Proposal Invoice` i
		join `tabSupplier Payment Proposal` p on p.name = i.parent
		left join `tabPayment Entry` pe on pe.name = i.payment_entry
		where i.purchase_invoice in %(invoices)s
			and p.name != %(exclude)s
			and p.docstatus < 2
			and (pe.name is null or pe.docstatus = 0)
			{conditions}
		""",
		{"invoices": invoices, "exclude": exclude_proposal or ""},
	)
	return dict(rows)


@frappe.whitelist()
def get_unpaid_invoices(company, currency, proposal=None, supplier=None, due_on_or_before=None):
	frappe.has_permission("Purchase Invoice", "read", throw=True)

	filters = {
		"company": company,
		"docstatus": 1,
		"is_return": 0,
		"outstanding_amount": (">", 0),
		"party_account_currency": currency,
	}
	if supplier:
		filters["supplier"] = supplier
	if due_on_or_before:
		filters["due_date"] = ("<=", due_on_or_before)

	names = frappe.get_list("Purchase Invoice", filters=filters, order_by="due_date asc", pluck="name")
	taken = get_invoices_in_open_proposals(names, proposal)

	invoices = []
	for name in names:
		if name in taken:
			continue
		pi = get_invoice_details(name, check_permission=False)
		if not get_invoice_error(pi, company, currency):
			invoices.append(pi)

	return invoices


@frappe.whitelist()
def make_proposal_from_invoices(invoices):
	"""Build an unsaved proposal from invoices picked in the Purchase Invoice list."""
	frappe.has_permission("Supplier Payment Proposal", "create", throw=True)

	invoices = frappe.parse_json(invoices)
	details = [get_invoice_details(name) for name in invoices]

	companies = {pi.company for pi in details}
	if len(companies) > 1:
		frappe.throw(_("Pick invoices from one company at a time."))

	doc = frappe.new_doc("Supplier Payment Proposal")
	doc.company = companies.pop()
	doc.payment_date = nowdate()
	doc.paid_from = frappe.get_cached_value("Company", doc.company, "default_bank_account")
	if doc.paid_from:
		doc.paid_from_account_currency = frappe.db.get_value("Account", doc.paid_from, "account_currency")

	skipped = []
	for pi in details:
		# Currency is checked on save, once the user has confirmed the Pay From account.
		error = get_invoice_error(pi, doc.company, None)
		if error:
			skipped.append(error)
		else:
			doc.append("invoices", {field: pi[field] for field in ("purchase_invoice", "amount_to_pay", *INVOICE_ROW_FIELDS)})

	if skipped:
		frappe.msgprint("<br>".join(skipped), title=_("Some invoices were left out"), indicator="orange")

	return doc
