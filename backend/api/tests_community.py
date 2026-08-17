"""Unit and integration tests for Account Location & Community Backend feature."""

from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from api.models import Community, CommunityPost, User


class CommunityFeatureTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_1_new_chennai_user_registration(self):
        """Test 1 — New Chennai user auto-creates & joins community."""
        response = self.client.post(
            "/api/auth/register",
            {
                "email": "user.chennai1@example.com",
                "password": "Password123!",
                "full_name": "Chennai User One",
                "role": "patient",
                "country": "India",
                "state": "Tamil Nadu",
                "city": "Chennai",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        user = User.objects.get(email="user.chennai1@example.com")
        self.assertEqual(user.country, "India")
        self.assertEqual(user.state, "Tamil Nadu")
        self.assertEqual(user.city, "Chennai")

        community = Community.objects.filter(country="India", state="Tamil Nadu", city="Chennai").first()
        self.assertIsNotNone(community)
        self.assertEqual(community.name, "Tinnitus Support – Chennai")
        self.assertEqual(user.community, community)
        self.assertEqual(community.members.count(), 1)

    def test_2_second_chennai_user_joins_existing_community(self):
        """Test 2 — Second Chennai user joins existing community without duplicate creation."""
        # User A registers
        self.client.post(
            "/api/auth/register",
            {
                "email": "user.a@example.com",
                "password": "Password123!",
                "full_name": "User A",
                "role": "patient",
                "country": "India",
                "state": "Tamil Nadu",
                "city": "Chennai",
            },
            format="json",
        )
        comm_count_before = Community.objects.count()

        # User B registers with same location
        response = self.client.post(
            "/api/auth/register",
            {
                "email": "user.b@example.com",
                "password": "Password123!",
                "full_name": "User B",
                "role": "patient",
                "country": "India",
                "state": "Tamil Nadu",
                "city": "Chennai",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        comm_count_after = Community.objects.count()
        self.assertEqual(comm_count_before, comm_count_after, "No duplicate community should be created")

        user_b = User.objects.get(email="user.b@example.com")
        community = Community.objects.get(country="India", state="Tamil Nadu", city="Chennai")
        self.assertEqual(user_b.community, community)
        self.assertEqual(community.members.count(), 2)

    def test_3_different_city_creates_separate_community(self):
        """Test 3 — Different city creates a separate community."""
        # Register Bangalore user
        response = self.client.post(
            "/api/auth/register",
            {
                "email": "user.bangalore@example.com",
                "password": "Password123!",
                "full_name": "Bangalore User",
                "role": "patient",
                "country": "India",
                "state": "Karnataka",
                "city": "Bangalore",
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        user_blr = User.objects.get(email="user.bangalore@example.com")
        community_blr = Community.objects.get(city="Bangalore")
        self.assertEqual(community_blr.name, "Tinnitus Support – Bangalore")
        self.assertEqual(user_blr.community, community_blr)

    def test_4_location_update_and_validation(self):
        """Test 4 — Location update validation and auto-join via API."""
        user = User.objects.create_user(
            email="existing.nolocation@example.com",
            password="Password123!",
            full_name="No Location User",
        )
        self.client.force_authenticate(user=user)

        # Missing fields should fail validation
        response = self.client.post("/api/communities/location", {"country": "India", "state": "", "city": ""}, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        # Valid payload updates location & assigns community
        response = self.client.post(
            "/api/communities/location",
            {"country": "India", "state": "Maharashtra", "city": "Mumbai"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        user.refresh_from_db()
        self.assertEqual(user.city, "Mumbai")
        self.assertIsNotNone(user.community)
        self.assertEqual(user.community.name, "Tinnitus Support – Mumbai")

    def test_5_existing_users_compatibility_and_community_posts(self):
        """Test 5 — Existing users without location remain compatible and post CRUD works."""
        existing_user = User.objects.create_user(
            email="old.user@example.com",
            password="Password123!",
            full_name="Old User",
        )
        self.client.force_authenticate(user=existing_user)

        # GET my-community returns has_community = False gracefully
        response = self.client.get("/api/communities/my-community")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(response.data["has_community"])
        self.assertIsNone(response.data["community"])

        # Update location to join community
        self.client.post(
            "/api/communities/location",
            {"country": "India", "state": "Tamil Nadu", "city": "Chennai"},
            format="json",
        )
        existing_user.refresh_from_db()

        # Create Post
        post_res = self.client.post("/api/communities/posts", {"content": "Hello Chennai community!"}, format="json")
        self.assertEqual(post_res.status_code, status.HTTP_201_CREATED)
        post_id = post_res.data["id"]

        # Verify post appears in community feed
        feed_res = self.client.get("/api/communities/my-community")
        self.assertEqual(feed_res.status_code, status.HTTP_200_OK)
        self.assertEqual(len(feed_res.data["posts"]), 1)
        self.assertEqual(feed_res.data["posts"][0]["content"], "Hello Chennai community!")
        self.assertTrue(feed_res.data["posts"][0]["is_own_post"])

        # Delete Post
        del_res = self.client.delete(f"/api/communities/posts/{post_id}")
        self.assertEqual(del_res.status_code, status.HTTP_200_OK)
        self.assertEqual(CommunityPost.objects.count(), 0)
