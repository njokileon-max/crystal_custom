import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

PROPOSAL = "Supplier Payment Proposal"
PROPOSAL_WORKFLOW = "Supplier Payment Proposal Approval"


def after_install():
    setup_supplier_payment_proposal()


def setup_supplier_payment_proposal():
    """Create the Payment Entry back-link and the approval workflow.

    The workflow is created once and never overwritten, so Finance can change
    the approver roles (or add a second approval level) from the desk.
    """
    create_custom_fields(
        {
            "Payment Entry": [
                {
                    "fieldname": "custom_supplier_payment_proposal",
                    "label": "Supplier Payment Proposal",
                    "fieldtype": "Link",
                    "options": PROPOSAL,
                    "insert_after": "reference_date",
                    "read_only": 1,
                    "no_copy": 1,
                    "in_standard_filter": 1,
                }
            ]
        },
        update=True,
    )

    if frappe.db.exists("Workflow", PROPOSAL_WORKFLOW):
        return

    for state, style in (
        ("Draft", ""),
        ("Pending Approval", "Warning"),
        ("Approved", "Success"),
        ("Rejected", "Danger"),
        ("Cancelled", "Danger"),
    ):
        if not frappe.db.exists("Workflow State", state):
            frappe.get_doc(
                {"doctype": "Workflow State", "workflow_state_name": state, "style": style}
            ).insert(ignore_permissions=True)

    for action in ("Submit for Approval", "Approve", "Reject", "Resubmit", "Cancel"):
        if not frappe.db.exists("Workflow Action Master", action):
            frappe.get_doc(
                {"doctype": "Workflow Action Master", "workflow_action_name": action}
            ).insert(ignore_permissions=True)

    preparer, approver = "Accounts User", "Accounts Manager"

    frappe.get_doc(
        {
            "doctype": "Workflow",
            "workflow_name": PROPOSAL_WORKFLOW,
            "document_type": PROPOSAL,
            "workflow_state_field": "workflow_state",
            "is_active": 1,
            "send_email_alert": 1,
            "states": [
                {"state": "Draft", "doc_status": "0", "allow_edit": preparer},
                {"state": "Pending Approval", "doc_status": "0", "allow_edit": approver},
                {"state": "Approved", "doc_status": "1", "allow_edit": approver},
                {"state": "Rejected", "doc_status": "0", "allow_edit": preparer},
                {"state": "Cancelled", "doc_status": "2", "allow_edit": approver},
            ],
            "transitions": [
                {"state": "Draft", "action": "Submit for Approval", "next_state": "Pending Approval",
                 "allowed": preparer, "allow_self_approval": 1},
                {"state": "Pending Approval", "action": "Approve", "next_state": "Approved",
                 "allowed": approver, "allow_self_approval": 0},
                {"state": "Pending Approval", "action": "Reject", "next_state": "Rejected",
                 "allowed": approver, "allow_self_approval": 0},
                {"state": "Rejected", "action": "Resubmit", "next_state": "Pending Approval",
                 "allowed": preparer, "allow_self_approval": 1},
                {"state": "Approved", "action": "Cancel", "next_state": "Cancelled",
                 "allowed": approver, "allow_self_approval": 1},
            ],
        }
    ).insert(ignore_permissions=True)
