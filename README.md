# toolify
A modern tool discovery and management platform designed to help users explore, organize, and access useful digital tools through a clean and intuitive interface.
# Toolify

**Discover. Explore. Organize.**

Toolify is a modern tool discovery platform designed to make finding and accessing useful digital tools easier. With a clean interface and an organized browsing experience, Toolify brings useful online resources together in one place.

## ✨ Overview

Toolify aims to simplify the way users discover and explore digital tools. Whether you're looking for tools for development, design, productivity, or everyday tasks, Toolify provides an organized platform to explore available resources.

## 🚀 Features

- **Modern Interface** — Clean, intuitive, and user-friendly design.
- **Tool Discovery** — Explore a collection of useful digital tools.
- **Organized Categories** — Browse tools through structured categories.
- **Easy Navigation** — Find and access tools with a straightforward experience.
- **Responsive Design** — Designed for a smooth experience across different screen sizes.

## 🎯 Purpose

The goal of Toolify is simple: make digital tools easier to discover and access by bringing useful resources into one organized platform.

## 🛠️ Built With

*Add the technologies used in your project here.*

## 📸 Preview

*Add screenshots of Toolify here.*

## 🌐 Live Demo

[Visit Toolify](tahaamindev.github.io/toolify)

## 💻 Getting Started

To run the project locally:

1. Clone the repository:

   ```bash
   git clone YOUR_REPOSITORY_URL
   ```

2. Navigate to the project directory:

   ```bash
   cd toolify
   ```

3. Open the project using your preferred development environment.

*Add framework-specific installation and run commands if applicable.*

## 📁 Project Structure

*Update this section according to your actual project structure.*

## 🤝 Contributing

Contributions, suggestions, and improvements are welcome. Feel free to fork the repository and submit a pull request.

## 📄 License

Add your preferred license to the repository.

## Music cloud storage

Music lists sync through the existing Supabase `settings` table. To sync audio/video files between signed-in devices, create a **private** Supabase Storage bucket named `toolify-music`, then add owner-only access policies for the authenticated user's folder. The app uploads each file under `<user-id>/<track-id>.<extension>`.

Run this in the Supabase SQL editor to create the bucket and policies:

```sql
insert into storage.buckets (id, name, public, file_size_limit)
values ('toolify-music', 'toolify-music', false, 52428800)
on conflict (id) do update set public = false;

create policy "Users can upload their own music"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'toolify-music'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Users can read their own music"
on storage.objects for select to authenticated
using (
  bucket_id = 'toolify-music'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Users can update their own music"
on storage.objects for update to authenticated
using (
  bucket_id = 'toolify-music'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'toolify-music'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Users can delete their own music"
on storage.objects for delete to authenticated
using (
  bucket_id = 'toolify-music'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
```

Local media stays available in the browser's IndexedDB as well. YouTube playback requires videos that allow embedding and a secure hosted origin (or localhost); YouTube may block private, age-restricted, or owner-disabled embeds.

---

**Toolify** — Making digital tool discovery simpler.
