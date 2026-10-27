import frappe

PROPOSAL_ROW = "Supplier Payment Proposal Invoice"


def on_submit(doc, method=None):
    """Mark the proposal Paid once all of its Payment Entries are submitted."""
    refresh_proposal_status(doc)


def on_cancel(doc, method=None):
    """Free the invoices so the proposal can create a fresh Payment Entry.

    Runs before Frappe's back-link check, so clearing the link here is also
    what lets the Payment Entry be cancelled at all.
    """
    unlink_from_proposal(doc)


def on_trash(doc, method=None):
    unlink_from_proposal(doc)


def unlink_from_proposal(doc):
    proposals = get_proposals(doc.name)
    if not proposals:
        return

    frappe.db.set_value(PROPOSAL_ROW, {"payment_entry": doc.name}, "payment_entry", None)
    for name in proposals:
        frappe.get_doc("Supplier Payment Proposal", name).update_payment_status()


def refresh_proposal_status(doc):
    for name in get_proposals(doc.name):
        frappe.get_doc("Supplier Payment Proposal", name).update_payment_status()


def get_proposals(payment_entry):
    return frappe.get_all(
        PROPOSAL_ROW,
        filters={"payment_entry": payment_entry, "parenttype": "Supplier Payment Proposal"},
        pluck="parent",
        distinct=True,
    )
