import os
import logging
from typing import Optional

import firebase_admin
from firebase_admin import credentials, firestore

# Optional: configure logging for this module
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("firestore_client")


class FirestoreClient:
    """
    Lightweight Firestore client wrapper.
    Initializes firebase_admin only once and exposes .db (firestore client).
    """

    def __init__(self, service_account_path: Optional[str] = None):
        # Allow environment fallback
        if not service_account_path:
            service_account_path = os.getenv(
                "SERVICE_ACCOUNT_PATH",
                "/home/HUSINPY/Husin_Network/Keys/service_account.json"
            )

        if not service_account_path or not os.path.exists(service_account_path):
            raise RuntimeError(f"Service account file not found: {service_account_path}")

        # Initialize app only once
        if not firebase_admin._apps:
            cred = credentials.Certificate(service_account_path)
            firebase_admin.initialize_app(cred)
            logger.info("Initialized Firebase app with provided service account.")
        else:
            logger.info("Firebase app already initialized; reusing existing app.")

        self.db = firestore.client()
