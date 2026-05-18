# Garrul + WordPress

Two ways to drop Garrul into a WordPress theme. Pick one. Both assume
your Worker is at `https://comments.yourdomain.com`.

## Option A — child theme (recommended)

Edit your child theme's `functions.php` and `comments.php`. This works
on classic and block themes alike.

`functions.php`:

```php
add_action('wp_enqueue_scripts', function () {
    if (is_singular('post')) {
        wp_enqueue_script(
            'garrul',
            'https://comments.yourdomain.com/embed.js',
            [],
            null,
            true   // load in footer
        );
    }
});
```

Replace your theme's `comments.php` with:

```php
<?php
if (post_password_required()) return;
$slug  = get_post_field('post_name', get_the_ID());
$title = get_the_title();
$url   = get_permalink();
?>
<section id="comments" class="garrul-wrap">
    <h2>Comments</h2>
    <div
        id="garrul"
        data-slug="<?php echo esc_attr($slug); ?>"
        data-api="https://comments.yourdomain.com"
        data-title="<?php echo esc_attr($title); ?>"
        data-url="<?php echo esc_url($url); ?>"
    ></div>
</section>
```

Then disable native WP comments for posts in **Settings → Discussion** so
you don't render two comment forms.

## Option B — plugin-less single-block injection

Skip the child theme. Drop this into a "Custom HTML" block at the bottom
of a post (works for one-off pages or testing):

```html
<div
    id="garrul"
    data-slug="hello-world"
    data-api="https://comments.yourdomain.com"
    data-title="Hello world"
    data-url="https://yourblog.com/hello-world/"
></div>
<script src="https://comments.yourdomain.com/embed.js" defer></script>
```

You'll have to hard-code the slug / URL per post, so this is really only
useful for a single demo page.

## Notes

- **Disable WP comments**: in WP-Admin → Settings → Discussion, uncheck
  "Allow people to submit comments on new posts." For old posts, edit
  them and uncheck "Allow comments" in the Discussion meta-box, or use
  WP-CLI: `wp post update <IDs> --comment_status=closed`.
- Add your WordPress site's origin to `ALLOWED_ORIGINS` in
  `wrangler.toml` (e.g. `https://yourblog.com`).
- The Cloudflare Worker handles all CSRF / spam protection — no
  WordPress nonce wiring needed.
- WordPress core's comment count helpers (`comments_number`,
  `get_comments_number`) won't reflect Garrul comments. If you want the
  count badge in your post list, fetch `GET /api/v1/counts?posts=a,b,c`
  from your theme footer JS and replace `.comments-link` text yourself.
